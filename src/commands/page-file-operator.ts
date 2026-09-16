import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { loadPageFileBootstrap, loadPageFileStartupBootstrap, pageFileBootstrapAnchorSchema, requirePageFilePilotAdmission } from '../core/page-file-bootstrap.ts';
import type { PageFileRuntimeEnrollment } from '../core/page-file-runtime.ts';
import type { OperationContext } from '../core/operations.ts';

const text = z.string().min(1).max(4096), digest = z.string().regex(/^[a-f0-9]{64}$/);
const anchorSchema = z.strictObject({ operatorPath: text, operatorSha256: digest });
const contractSchema = z.strictObject({ version: z.literal(1), mode: z.enum(['offline-verification', 'production-pilot']),
  bootstrap: pageFileBootstrapAnchorSchema,
  enrollmentCredentialPath: text, enrollmentCredentialSha256: digest, reviewedPath: text, reviewedSha256: digest });
const reviewedSchema = z.strictObject({ hostManifestSha256: digest, source: text, slug: text, pageId: text,
  revision: text, canonicalRoot: text, relativePath: text, rawSha256: digest });
const invalid = () => new Error('page_file_operator_invalid');
function local(ctx: { remote?: unknown }) { if (ctx.remote !== false) throw new Error('page_file_operator_denied'); }
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const identity = (s: import('node:fs').BigIntStats) => [s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
/** Operator-only reader; bootstrap's private reader intentionally remains private.
 * Same no-follow, bounded descriptor/path/ancestor identity contract. */
function protectedFile(path: string) {
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path) throw invalid();
  const uid = process.getuid?.(); if (uid === undefined) throw invalid();
  const parents: string[] = [];
  for (let p = dirname(path); ; p = dirname(p)) {
    const s = lstatSync(p,{bigint:true});
    if (!s.isDirectory() || (s.mode & 0o022n) !== 0n || (s.uid !== 0n && s.uid !== BigInt(uid))) throw invalid();
    parents.push([p,s.dev,s.ino,s.uid,s.gid,s.mode].join(':'));
    if (p === dirname(p)) break;
  }
  const fd = openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd,{bigint:true});
    if (!s.isFile() || s.uid !== BigInt(uid) || s.nlink !== 1n || (s.mode & 0o7777n) !== 0o400n || s.size > 1048576n) throw invalid();
    const bytes = readFileSync(fd), key = identity(s);
    if (key !== identity(fstatSync(fd,{bigint:true})) || key !== identity(lstatSync(path,{bigint:true}))) throw invalid();
    return { bytes, fingerprint: [key,...parents,sha(bytes)].join('|') };
  } finally { closeSync(fd); }
}
const authorized = new WeakSet<object>();
/** Trusted local file loader, not an MCP operation or worker capability. The path
 * override is for offline fixtures; the executable has no path/env override. */
export function loadPageFileOperator(ctx: { remote?: unknown }, path = '/etc/gbrain/page-file-operator-anchor.json') {
  local(ctx);
  try {
    const anchorFile = protectedFile(path), anchor = anchorSchema.parse(JSON.parse(anchorFile.bytes.toString()));
    const file = protectedFile(anchor.operatorPath);
    if (sha(file.bytes) !== anchor.operatorSha256) throw invalid();
    const contract = contractSchema.parse(JSON.parse(file.bytes.toString()));
    const bootstrap = loadPageFileBootstrap(contract.bootstrap);
    if (bootstrap.status === 'disabled' || bootstrap.status !== contract.mode) throw invalid();
    const reviewedFile = protectedFile(contract.reviewedPath);
    if (sha(reviewedFile.bytes) !== contract.reviewedSha256) throw invalid();
    const reviewed = Object.freeze(reviewedSchema.parse(JSON.parse(reviewedFile.bytes.toString())));
    if (bootstrap.status === 'production-pilot') {
      const approved = requirePageFilePilotAdmission(bootstrap.admission);
      if (reviewed.source !== approved.source || reviewed.slug !== approved.slug) throw invalid();
    }
    if (reviewed.hostManifestSha256 !== bootstrap.contract.expected.manifestSha256
      || contract.enrollmentCredentialPath === bootstrap.contract.credentialPath
      || contract.enrollmentCredentialSha256 === bootstrap.contract.credentialSha256) throw invalid();
    const manifest = JSON.parse(protectedFile(bootstrap.contract.manifestPath).bytes.toString());
    const roots = [...manifest.indexedRoots, ...manifest.roots.map((r: any) => r.directory)];
    for (const p of [path,anchor.operatorPath,contract.reviewedPath,contract.enrollmentCredentialPath])
      if (roots.some((r: any) => p === r.path || p.startsWith(r.path === '/' ? '/' : r.path + '/'))) throw invalid();
    const revalidate = () => {
      try {
        if (protectedFile(path).fingerprint !== anchorFile.fingerprint
          || protectedFile(anchor.operatorPath).fingerprint !== file.fingerprint
          || protectedFile(contract.reviewedPath).fingerprint !== reviewedFile.fingerprint) throw invalid();
        bootstrap.revalidate();
      } catch { throw invalid(); }
    };
    const loaded = Object.freeze({ reviewed, revalidate,
      verifyStartup() {
        revalidate(); const startup = loadPageFileStartupBootstrap();
        if (startup.status === 'disabled' || startup.status !== bootstrap.status || !isDeepStrictEqual(startup.contract,bootstrap.contract)) throw invalid();
        if (startup.status === 'production-pilot' && !isDeepStrictEqual(requirePageFilePilotAdmission(startup.admission), requirePageFilePilotAdmission(bootstrap.admission))) throw invalid();
      },
      async enrollment(caller: { remote?: unknown }): Promise<PageFileRuntimeEnrollment> {
        local(caller);
        try {
          revalidate();
          const secret = protectedFile(contract.enrollmentCredentialPath);
          if (sha(secret.bytes) !== contract.enrollmentCredentialSha256) throw invalid();
          const fingerprint = secret.fingerprint; secret.bytes.fill(0);
          const roles = bootstrap.contract.sqlAuthority.roles;
          return { reviewed: {...reviewed}, authority: {
            mode:bootstrap.status, admission:bootstrap.admission, adapterRole:roles.adapter, credentialReference:contract.enrollmentCredentialPath,
            expected:{role:roles.enrollment,ordinaryRole:roles.ordinary,database:bootstrap.contract.expected.database},
            sqlAuthority:{...bootstrap.contract.sqlAuthority,role:roles.enrollment,database:bootstrap.contract.expected.database},
            async revalidate() { revalidate(); const s=protectedFile(contract.enrollmentCredentialPath); try { if(s.fingerprint!==fingerprint) throw invalid(); } finally {s.bytes.fill(0);} },
            async resolveCredential(reference) {
              try {
                revalidate(); if(reference!==contract.enrollmentCredentialPath) throw invalid();
                const s=protectedFile(reference);
                try { if(s.fingerprint!==fingerprint) throw invalid(); const value=s.bytes.toString().trim(); if(!/^postgres(?:ql)?:\/\//.test(value)) throw invalid(); return value; }
                finally {s.bytes.fill(0);}
              } catch {throw invalid();}
            },
          }};
        } catch { throw invalid(); }
      },
    });
    authorized.add(loaded); return loaded;
  } catch { throw invalid(); }
}

type Operator = ReturnType<typeof loadPageFileOperator>;
/** One reviewed page per invocation. No discovery-to-enrollment or auto-recovery. */
export async function runPageFileOperator(ctx: Pick<OperationContext,'engine'|'config'|'remote'>, operator: Operator, action: string) {
  local(ctx);
  try {
    if (!authorized.has(operator) || !['status','verify','enroll'].includes(action) || ctx.config.page_file_runtime?.mode === 'production') throw invalid();
    operator.verifyStartup();
    const { hasPageFileRuntimeCandidate, enrollPageFileRuntime, resolvePageFileRuntime } = await import('../core/page-file-runtime.ts');
    if (!await hasPageFileRuntimeCandidate(ctx.engine)) throw invalid();
    const {source,slug} = operator.reviewed;
    if (action === 'enroll') {
      const result = await enrollPageFileRuntime(ctx,source,slug,await operator.enrollment(ctx));
      operator.revalidate();
      // Exact target readback through existing private adapter, never raw content output.
      const runtime = await resolvePageFileRuntime(ctx,source,slug);
      if (!runtime) throw invalid();
      await runtime.pages.get(source,slug,()=>{});
      return {status:result.status};
    }
    // SQL observation does not acquire authority, repair or choose a recovery winner.
    const [binding] = await ctx.engine.executeRaw<{pending_op_id:string|null}>('SELECT pending_op_id FROM page_file_bindings WHERE source_id=$1 AND slug=$2',[source,slug]);
    operator.revalidate();
    if (!binding) return {status:'not_enrolled'};
    if (binding.pending_op_id) return {status:'pending_recovery'};
    const runtime = await resolvePageFileRuntime(ctx,source,slug);
    if (!runtime) throw invalid();
    await runtime.pages.get(source,slug,()=>{});
    operator.revalidate();
    return {status:'verified'};
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (['pending_recovery','sync_required','page_file_root_sync_required'].includes(code)) return {status:code};
    throw invalid();
  }
}

export const PAGE_FILE_OPERATOR_HELP = 'Usage: bun src/commands/page-file-operator.ts <status|verify|enroll>\nOffline only; fixed /etc/gbrain/page-file-operator-anchor.json. One pinned reviewed page. No migrations or automatic recovery.';
if (import.meta.main) {
  const args=process.argv.slice(2);
  if (args.length===1 && args[0]==='--help') console.log(PAGE_FILE_OPERATOR_HELP);
  else if (args.length!==1 || !['status','verify','enroll'].includes(args[0])) { console.error(PAGE_FILE_OPERATOR_HELP); process.exit(2); }
  else {
    // Ordinary config remains ordinary. Enrollment credentials are never added
    // to shared config, environment, workers, engine constructors or MCP context.
    let engine: import('../core/postgres-engine.ts').PostgresEngine | undefined;
    try {
      const operator=loadPageFileOperator({remote:false}); operator.verifyStartup();
      const {loadConfig}=await import('../core/config.ts'); const config=loadConfig();
      if (!config || config.engine!=='postgres') throw invalid();
      const {PostgresEngine}=await import('../core/postgres-engine.ts'); engine=new PostgresEngine();
      await engine.connect(config);
      const result=await runPageFileOperator({engine,config,remote:false},operator,args[0]);
      await engine.disconnect(); engine=undefined;
      console.log(JSON.stringify(result));
    } catch {
      try {await engine?.disconnect();} catch { /* only fixed redacted error below */ }
      console.error('page_file_operator_failed'); process.exit(1);
    }
  }
}
