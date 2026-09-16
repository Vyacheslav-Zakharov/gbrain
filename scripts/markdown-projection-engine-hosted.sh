#!/usr/bin/env bash
# Hosted only; no local namespace, network, container or database execution.
set -euo pipefail
case ${MARKDOWN_PROJECTION_WORKER_MODE:-} in
 isolated|legacy) export MARKDOWN_PROJECTION_WORKER_MODE ;;
 *) printf '%s\n' 'explicit MARKDOWN_PROJECTION_WORKER_MODE isolated|legacy required' >&2; exit 1 ;;
esac
[[ ${GITHUB_ACTIONS:-} == true ]]
[[ ${MARKDOWN_PROJECTION_DISPOSABLE:-} == CREATE_AND_DROP_DATABASE ]]
: "${MARKDOWN_PROJECTION_EXPECTED_SERVICE_IP:?docker-inspected service IP required}"
[[ ${MARKDOWN_PROJECTION_ADMIN_URL:-} == postgres://postgres@127.0.0.1:5432/postgres ]]
for tool in socat sudo unshare setpriv ip timeout bun python3; do command -v "$tool" >/dev/null; done
base=$(pwd); bun=$(command -v bun)
uid=$(id -u); gid=$(id -g); [[ $uid != 0 ]]
relay=$(mktemp -d /tmp/mp-engine-relay-XXXXXXXX)
hostns=$(readlink /proc/self/ns/net)
trap 'rc=$?; rm -rf -- "$relay" || { [[ $rc != 0 ]] || rc=1; }; exit "$rc"' EXIT
runtime=$(mktemp -d "$(dirname "$base")/mp-runtime-XXXXXXXX")
chmod 700 "$runtime"
trap 'rc=$?; rm -rf -- "$relay" "$runtime" || { [[ $rc != 0 ]] || rc=1; }; exit "$rc"' EXIT
export base bun uid gid relay hostns runtime
python3 scripts/markdown-projection-engine-supervisor.py outer "$relay" \
 timeout -k 10s 170s sudo --preserve-env=base,bun,uid,gid,relay,hostns,runtime,MARKDOWN_PROJECTION_EXPECTED_SERVICE_IP,MARKDOWN_PROJECTION_WORKER_MODE unshare --net bash -c '
set -euo pipefail
ip link set lo up
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs env -i PATH=/usr/bin:/bin MARKDOWN_PROJECTION_WORKER_MODE="$MARKDOWN_PROJECTION_WORKER_MODE" HOME="$relay" MARKDOWN_PROJECTION_RUNTIME_ROOT="$runtime" GITHUB_ACTIONS=true GBRAIN_DISABLE_DIRECT_POOL=1 MARKDOWN_PROJECTION_RUNNER_UID="$uid" MARKDOWN_PROJECTION_RUNNER_GID="$gid" MARKDOWN_PROJECTION_HOST_NETNS="$hostns" MARKDOWN_PROJECTION_EXPECTED_SERVICE_IP="$MARKDOWN_PROJECTION_EXPECTED_SERVICE_IP" MARKDOWN_PROJECTION_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres MARKDOWN_PROJECTION_DISPOSABLE=CREATE_AND_DROP_DATABASE python3 "$base/scripts/markdown-projection-engine-supervisor.py" inner "$relay" "$bun" run "$base/scripts/markdown-projection-engine-hosted.ts"
'
# Workflow always-step must still verify disposable DB absence and remove service.
