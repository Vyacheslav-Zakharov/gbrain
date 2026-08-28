# G5-B control binding stale — independently verified

Date: 2026-08-28
Status: BLOCKER / NO-GO
Production mutation: none

`sha256sum -c /home/avers/g5b-14592bab-control/G5B-CONTROL-SHA256SUMS` returned exit 1 with exactly two mismatches:

| Artifact | Bound SHA-256 | Current SHA-256 |
|---|---|---|
| `/home/avers/g5a-14592bab-control/G5-RUNBOOK-G5A-AMENDED.md` | `c81772827c3017c26ff5d0fca43ce6267465ede7ac6c9d73070d5db044288a21` | `d338e85ba0c4b44a20b16f088e068db4e9fe1dadedf69bc6220c1983759863e3` |
| `/home/avers/g5a-14592bab-control/g5a-backup-payload.sh` | `78862423669601611dcb1348b2d7333bb53d868ebeba54f41f34ea419e1fcde7` | `46700c3297f64f38cfe63f7df079968b8f1a09932dc9efeaaff90bf4babbd2b1` |

All other entries in the manifest verified successfully during the same check.

The existing G5-B binding is not valid for execution. Do not overwrite or silently rebind it. Required recovery: determine provenance of both byte changes, exact diff review, regenerate the complete manifest, and obtain a fresh independent binding/review. This blocker is separate from the Stage 2 ACL package.
