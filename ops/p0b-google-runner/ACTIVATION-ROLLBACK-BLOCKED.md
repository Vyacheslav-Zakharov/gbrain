# P0-B activation and rollback gate

Status: **UNFINALIZED_NOEXEC**. This successor is offline-testable, not deployable.

No activation or rollback executable exists. Every systemd artifact retains the
`.NOEXEC` suffix and has no `[Install]` section. Service units use
`ExecCondition=/usr/bin/false`; the socket additionally has the always-false unit
condition `ConditionPathExists=!/` and `SocketMode=0000`. These files must not be
renamed, installed, enabled, or applied.

Implemented and executable only through dependency-injected offline tests:

- bounded four-byte big-endian byte framing over a real AF_UNIX socket;
- bounded input count, per-string bytes, aggregate input bytes, request frame, response
  frame, random 256-bit request nonce, and absolute AbortSignal deadlines;
- a required Linux SO_PEERCRED adapter seam, deny-by-default when absent, with exact
  UID/GID policy enforcement before credential or HTTPS access;
- fixed systemd credential open/read/close with Linux
  `O_RDONLY|O_NOFOLLOW|O_CLOEXEC`, fstat/read/re-fstat on the same descriptor, bounded
  ASCII secret material, temporary-buffer zeroing, and fatal close failures;
- an injected HTTPS seam for offline tests and a production adapter pinned to exactly
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents`,
  model `gemini-embedding-001`, 768 dimensions, no redirects, bounded response bytes,
  and an absolute AbortSignal;
- an exact immutable-package root algorithm and verifier that rejects symlinks,
  unlisted files, mutable ownership/modes, descriptor races, and digest mismatches.

Activation and rollback remain blocked until all of the following are independently
ratified against exact candidate/package bytes:

1. final PostgreSQL schema/ACL/RLS and the executable legacy-writer fence are rehearsed
   on PostgreSQL 16;
2. a stable non-login socket group and stable bridge/provider UIDs are selected, and a
   native Linux SO_PEERCRED adapter is built/reviewed for Bun/Node;
3. an approved egress mechanism is finalized. The provider service currently permits
   AF_UNIX only, so production Google HTTPS is deliberately impossible;
4. the credential source, final root-owned package layout, finalized signed manifest,
   and launch-time verifier binding are installed and independently reviewed;
5. signed lifecycle authorization, signer policy, action/transition binding, replay
   persistence, independently enforcing CAS, and rollback preservation/restore are
   implemented. Hash possession is not authorization;
6. the reconciler runner receives cancellable adapters and fail-safe idempotent lease
   cleanup with an independently bounded cleanup deadline and persisted lease expiry.
   Until then the runner's first instruction remains the NOEXEC fence.

No live service, timer, database, provider, credential store, root path, or network is
modified by this offline package.
