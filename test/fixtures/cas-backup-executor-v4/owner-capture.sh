#!/bin/sh
# FUTURE OWNER TERMINAL ONLY. Not authority to execute.
set -eu
umask 077
: "${REVIEWED_MANIFEST:?absolute final manifest path required}"
: "${REVIEWED_MANIFEST_SHA256:?independently reviewed digest required}"
: "${REVIEWED_EXECUTOR_SHA256:?independently reviewed executor digest required}"
: "${EXECUTION_AUTHORIZATION:?exact approved authorization JSON required}"
: "${EXECUTION_AUTHORIZATION_SHA256:?independently trusted authorization digest required}"
: "${INDEPENDENT_FENCE_RECEIPT:?reviewed ongoing writer fence receipt required}"
: "${INDEPENDENT_FENCE_RECEIPT_SHA256:?independently trusted fence digest required}"
D=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ACTUAL=$(sha256sum "$D/capture.py")
ACTUAL=${ACTUAL%% *}
[ "$ACTUAL" = "$REVIEWED_EXECUTOR_SHA256" ] || { printf '%s\n' 'Executor hash mismatch' >&2; exit 2; }
exec /usr/bin/python3 -B "$D/capture.py" "$REVIEWED_MANIFEST" \
 --manifest-sha256 "$REVIEWED_MANIFEST_SHA256" --execute \
 --authorization "$EXECUTION_AUTHORIZATION" --authorization-sha256 "$EXECUTION_AUTHORIZATION_SHA256" \
 --fence "$INDEPENDENT_FENCE_RECEIPT" --fence-sha256 "$INDEPENDENT_FENCE_RECEIPT_SHA256"
