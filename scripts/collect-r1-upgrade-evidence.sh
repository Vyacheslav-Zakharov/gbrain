#!/usr/bin/env bash
# Read-only, redaction-first evidence collector for GBrain R1.
# It intentionally does not use `set -e`: every collector runs and is recorded.
set -u -o pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT=""
TEST_MODE=0

usage() {
  printf 'Usage: %s --output <absolute-directory> [--repo-root <absolute-directory>] [--test-mode]\n' "$0" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      OUTPUT="$2"; shift 2 ;;
    --repo-root)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      ROOT="$2"; shift 2 ;;
    --test-mode)
      TEST_MODE=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$OUTPUT" ] || { usage; exit 2; }
case "$OUTPUT" in
  /*) ;;
  *) printf 'ERROR: --output must be absolute\n' >&2; exit 2 ;;
esac
case "$ROOT" in
  /*) ;;
  *) printf 'ERROR: --repo-root must be absolute\n' >&2; exit 2 ;;
esac
mkdir -p "$OUTPUT" || exit 2
chmod 700 "$OUTPUT" 2>/dev/null || true
STATUS_TSV="$OUTPUT/collector-status.tsv"
: > "$STATUS_TSV"

redact_stream() {
  python3 -c '
import os,re,sys
s=sys.stdin.read()
# URI userinfo, including DB passwords.
s=re.sub(r"(?i)([a-z][a-z0-9+.-]*://)([^/@\s:]+):([^/@\s]+)@", r"\1<redacted>@", s)
# JSON/YAML/key-value secrets. Keep key name for diagnostic value.
s=re.sub(r"(?i)([\"\x27]?(?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)[\"\x27]?\s*[:=]\s*[\"\x27]?)([^\"\x27\s,;}]+)", r"\1<redacted>", s)
# Bearer/basic payloads.
s=re.sub(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 <redacted>", s)
# Known test canaries and any explicitly supplied collector canary.
for value in (os.environ.get("R1_TEST_SECRET"),):
    if value:
        s=s.replace(value,"<redacted>")
s=s.replace("user:password@","<redacted>@")
sys.stdout.write(s)
'
}

collect() {
  local name="$1"; shift
  local raw="$OUTPUT/.${name}.raw"
  local final="$OUTPUT/${name}.txt"
  "$@" >"$raw" 2>&1
  local rc=$?
  redact_stream <"$raw" >"$final"
  rm -f "$raw"
  local status="ok"
  [ "$rc" -eq 0 ] || status="failed"
  printf '%s\t%s\t%s\n' "$name" "$status" "$rc" >> "$STATUS_TSV"
  return 0
}

if [ "$TEST_MODE" -eq 1 ]; then
  collect test_safe printf 'safe output\n'
  collect test_failure bash -c 'printf "synthetic failure\n" >&2; exit 7'
  collect test_secret printf 'API_KEY=%s\n' "${R1_TEST_SECRET:-unset}"
  collect test_database_url printf 'database_url=%s\n' "${R1_TEST_DATABASE_URL:-unset}"
else
  PLAN="/home/avers/.hermes/plans/2026-08-25_081500-gbrain-governed-upgrade-plan-v2.md"
  OWNER="/home/avers/.hermes/cache/documents/doc_d6cc210e50b7_hermes-upgrade-owner-decisions.md"
  REVIEW="/home/avers/.hermes/cache/documents/doc_6be96972cd52_hermes-governed-upgrade-plan-review.md"
  GUARD="/home/avers/.gbrain/update-guard/gbrain-customizations/0.42.53.0/manifest.json"
  INSTALL="/home/avers/.bun/install/global/node_modules/gbrain"

  collect artifact_inputs bash -c 'for p in "$@"; do if [ -f "$p" ]; then sha256sum "$p"; wc -c "$p"; else printf "MISSING %s\n" "$p"; fi; done' _ "$PLAN" "$OWNER" "$REVIEW"
  collect git_identity git -C "$ROOT" rev-parse HEAD
  collect git_status git -C "$ROOT" status --porcelain=v1
  collect git_remotes git -C "$ROOT" remote -v
  collect git_lineage bash -c 'set -u; root="$1"; git -C "$root" rev-parse upstream-v0.46.29.0; git -C "$root" merge-base HEAD upstream-v0.46.29.0; git -C "$root" rev-list --left-right --count HEAD...upstream-v0.46.29.0' _ "$ROOT"
  collect package_version python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("version")); print(d.get("name"))' "$ROOT/package.json"
  collect guard_summary python3 -c 'import hashlib,json,sys; p=sys.argv[1]; b=open(p,"rb").read(); d=json.loads(b); print("sha256",hashlib.sha256(b).hexdigest()); print("version",d.get("version")); print("source_commit",d.get("source_commit")); print("source_base",d.get("source_base")); print("files",len(d.get("files",{})))' "$GUARD"
  collect guard_parity python3 -c '
import hashlib,json,os,sys
manifest,install=sys.argv[1:]
d=json.load(open(manifest)); missing=[]; mismatch=[]; ok=0
for rel,meta in d.get("files",{}).items():
 p=os.path.join(install,rel)
 if not os.path.isfile(p): missing.append(rel); continue
 h=hashlib.sha256(open(p,"rb").read()).hexdigest()
 if h!=meta.get("sha256"): mismatch.append(rel)
 else: ok+=1
print("ok",ok); print("missing",len(missing)); print("mismatch",len(mismatch))
for x in missing: print("MISSING",x)
for x in mismatch: print("MISMATCH",x)
' "$GUARD" "$INSTALL"
  collect installed_entrypoints bash -c 'set -u; install="$1"; readlink -f /home/avers/.bun/bin/gbrain; sha256sum "$install/src/cli.ts" "$install/package.json"; stat -c "%a %U:%G %n" /home/avers/.bun/bin/gbrain "$install/src/cli.ts" "$install/package.json"' _ "$INSTALL"
  collect service_units bash -c 'systemctl --user list-unit-files "gbrain*" --no-pager --no-legend; systemctl --user list-units "gbrain*" --all --no-pager --no-legend'
  collect service_runtime bash -c '
units=$(systemctl --user list-unit-files "gbrain*" --no-legend 2>/dev/null | sed -n "s/[[:space:]].*//p")
for u in $units; do systemctl --user show "$u" -p Id -p LoadState -p ActiveState -p SubState -p MainPID -p FragmentPath -p ExecStart --no-pager 2>/dev/null; done
'
  collect autopilot_hold python3 -c '
import hashlib,json,os,sys
state=sys.argv[1]
for name in ["HOLD.json","expected-source-commit","runtime.sha256","commissioned.json"]:
 p=os.path.join(state,name)
 if not os.path.isfile(p):
  print(name,"absent"); continue
 b=open(p,"rb").read(); print(name,"present","bytes",len(b),"sha256",hashlib.sha256(b).hexdigest())
 if name=="HOLD.json":
  try:
   d=json.loads(b); print("hold_keys",sorted(d.keys())); print("hold_status",d.get("status")); print("hold_active",d.get("status")=="hold")
  except Exception: print("hold_parse","failed")
 if name=="expected-source-commit": print("expected_source_commit",b.decode("utf-8","replace").strip())
' /home/avers/.gbrain/state/autopilot-bounded
  collect process_summary bash -c 'ps -eo pid=,ppid=,etimes=,comm= | while read -r pid ppid age comm; do case "$comm" in *gbrain*|*bun*) printf "%s %s %s %s\n" "$pid" "$ppid" "$age" "$comm";; esac; done'
  collect config_redacted python3 -c '
import json,re,sys
p=sys.argv[1]; d=json.load(open(p))
def clean(k,v):
 if re.search(r"key|secret|password|token",k,re.I): return "<present>" if v else "<absent>"
 if isinstance(v,dict): return {x:clean(x,y) for x,y in v.items()}
 if isinstance(v,list): return [clean(k,x) for x in v]
 if isinstance(v,str) and "://" in v: return re.sub(r"(://)([^/@:]+):([^/@]+)@",r"\1<redacted>@",v)
 return v
print(json.dumps({k:clean(k,v) for k,v in d.items()},indent=2,sort_keys=True))
' /home/avers/.gbrain/config.json
  collect env_presence python3 -c '
import os
keys=["ZEROENTROPY_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","OPENAI_API_KEY","VOYAGE_API_KEY","GBRAIN_EMBEDDING_MODEL","GBRAIN_EMBEDDING_DIMENSIONS","GBRAIN_SOURCE","GBRAIN_BRAIN_ID"]
for k in keys: print(k, "present" if os.environ.get(k) else "absent")
'
  collect db_config bash -lc 'source ~/.gbrain/pg.sh >/dev/null 2>&1; psql "$DATABASE_URL" -X -A -F "," -c "SELECT key,value FROM config WHERE key IN ('\''version'\'','\''embedding_model'\'','\''embedding_dimensions'\'','\''search_embedding_column'\'','\''search.mode'\'','\''search.reranker.enabled'\'','\''search.reranker.model'\'','\''autopilot.enabled'\'') ORDER BY key;"'
  collect db_counts bash -lc 'source ~/.gbrain/pg.sh >/dev/null 2>&1; psql "$DATABASE_URL" -X -A -F "," -c "SELECT (SELECT count(*) FROM sources) sources,(SELECT count(*) FROM pages WHERE deleted_at IS NULL) live_pages,(SELECT count(*) FROM content_chunks) chunks,(SELECT count(*) FROM facts) facts,(SELECT count(*) FROM query_cache) query_cache,(SELECT count(*) FROM takes) takes;"'
  collect vector_catalog bash -lc 'source ~/.gbrain/pg.sh >/dev/null 2>&1; psql "$DATABASE_URL" -X -A -F "," -c "SELECT c.relname AS table_name,a.attname AS column_name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='\''public'\'' AND a.attnum>0 AND NOT a.attisdropped AND pg_catalog.format_type(a.atttypid,a.atttypmod) ~ '\''^(vector|halfvec)\\('\'' ORDER BY c.relname,a.attname;"'
  collect vector_counts bash -lc 'source ~/.gbrain/pg.sh >/dev/null 2>&1; psql "$DATABASE_URL" -X -A -F "," -c "SELECT '\''content_chunks.embedding'\'' plane,count(*) total,count(embedding) populated FROM content_chunks UNION ALL SELECT '\''content_chunks.embedding_image'\'',count(*),count(embedding_image) FROM content_chunks UNION ALL SELECT '\''content_chunks.embedding_multimodal'\'',count(*),count(embedding_multimodal) FROM content_chunks UNION ALL SELECT '\''facts.embedding'\'',count(*),count(embedding) FROM facts UNION ALL SELECT '\''query_cache.embedding'\'',count(*),count(embedding) FROM query_cache UNION ALL SELECT '\''takes.embedding'\'',count(*),count(embedding) FROM takes;"'
  collect embedding_state bash -lc 'source ~/.gbrain/pg.sh >/dev/null 2>&1; psql "$DATABASE_URL" -X -A -F "," -c "SELECT model,count(*) chunks,sum(token_count) token_count,min(embedded_at),max(embedded_at) FROM content_chunks GROUP BY model ORDER BY count(*) DESC; SELECT count(*) FILTER (WHERE embedding IS NULL) null_vectors,count(*) FILTER (WHERE embedding_signature IS NULL) null_signatures FROM pages p LEFT JOIN content_chunks c ON c.page_id=p.id WHERE p.deleted_at IS NULL;"'
  collect migration_state bash -lc 'source ~/.gbrain/pg.sh >/dev/null 2>&1; psql "$DATABASE_URL" -X -A -F "," -c "SELECT value AS scalar_version FROM config WHERE key='\''version'\''; SELECT to_regclass('\''public.source_connector_configs'\'') source_connector_configs,to_regclass('\''public.ai_review_rounds'\'') ai_review_rounds,to_regclass('\''public.session_context_state'\'') session_context_state,to_regclass('\''public.chat_usage_log'\'') chat_usage_log;"'
  collect migration_source_matrix python3 -c '
import re,sys
s=open(sys.argv[1],encoding="utf-8").read()
for m in re.finditer(r"version:\s*(\d+),\s*\n\s*name:\s*[\x27\x22]([^\x27\x22]+)",s): print(m.group(1),m.group(2))
' "$ROOT/src/core/migrate.ts"
  collect jobs_summary bash -lc 'source ~/.gbrain/pg.sh >/dev/null 2>&1; psql "$DATABASE_URL" -X -A -F "," -c "SELECT status,count(*) FROM minion_jobs GROUP BY status ORDER BY status;"'
  collect db_locks bash -lc 'source ~/.gbrain/pg.sh >/dev/null 2>&1; psql "$DATABASE_URL" -X -A -F "," -c "SELECT state,wait_event_type,wait_event,count(*) FROM pg_stat_activity WHERE datname=current_database() GROUP BY state,wait_event_type,wait_event ORDER BY state,wait_event_type,wait_event;"'
  collect db_capacity bash -lc 'source ~/.gbrain/pg.sh >/dev/null 2>&1; psql "$DATABASE_URL" -X -A -F "," -c "SELECT current_database(),pg_database_size(current_database()) database_bytes,pg_current_wal_lsn() wal_lsn; SELECT relname,pg_total_relation_size(c.oid) total_bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='\''public'\'' AND relname IN ('\''content_chunks'\'','\''facts'\'','\''query_cache'\'','\''takes'\'') ORDER BY relname;"'
  collect disk_capacity df -B1 /home/avers
fi

python3 - "$OUTPUT" "$STATUS_TSV" <<'PY'
import datetime,hashlib,json,os,sys
out,status_path=sys.argv[1:]
collectors=[]
with open(status_path,encoding='utf-8') as f:
    for line in f:
        name,status,code=line.rstrip('\n').split('\t')
        collectors.append({'name':name,'status':status,'exit_code':int(code)})
files=[]
for name in sorted(os.listdir(out)):
    if name.startswith('.') or name=='manifest.json':
        continue
    p=os.path.join(out,name)
    if not os.path.isfile(p):
        continue
    b=open(p,'rb').read()
    files.append({'path':name,'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)})
manifest={
    'schema_version':1,
    'generated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'complete':all(x['status']=='ok' for x in collectors),
    'collectors':collectors,
    'files':files,
}
tmp=os.path.join(out,'.manifest.json.tmp')
with open(tmp,'w',encoding='utf-8') as f:
    json.dump(manifest,f,indent=2,sort_keys=True)
    f.write('\n')
os.replace(tmp,os.path.join(out,'manifest.json'))
PY

failures=$(awk -F '\t' '$2 != "ok" {n++} END {print n+0}' "$STATUS_TSV")
if [ "$failures" -gt 0 ]; then
  printf 'evidence complete with collector failures: %s; output=%s\n' "$failures" "$OUTPUT" >&2
  exit 1
fi
printf 'evidence complete: output=%s\n' "$OUTPUT" >&2
exit 0
