# Owner acceptances — G5-B risk posture

- Owner: Vyacheslav
- Date: `2026-08-28T10:55:41+05:00`
- Candidate: `14592bab92a572292e93fe4bf6363ac2212751ba`

The owner explicitly accepts all six items for inclusion in the future artifact-bound G5-B record:

1. **Full-DB-restore as the SOLE rollback posture.** Application-only rollback is not authorized.
2. **Bounded-clone envelope in lieu of MemoryPeak/swap/descendant census.**
3. **Equal-width fixture N/A to the fixed 1280→768 transition.**
4. **Egress-sweep boundary:** the hash-pinned sweep covers executable string/template literals in `src/` and `scripts/` for `.ts/.mjs/.sh`; dynamically composed strings, other extensions, docs and test fixtures are outside that boundary.
5. **Legacy ZE residual:** allowlisted ZE recipe/`ze-switch` surfaces remain operator-invocable until R2, must not be invoked after the governed cutoff, and any allowlist edit requires focused security sign-off.
6. **89 unguarded production fork paths residual:** accepted with compensation by the §3 `GBRAIN_SKIP_STARTUP_HOOKS=1` control and explicit prohibition on `gbrain upgrade` / `gbrain self-upgrade` throughout the fence and observation window.

These acceptances do not authorize G5-B by themselves. Fresh migration-window G5-A, final exact binding/reviews and separate literal artifact-bound `G5-B MIGRATION GO` remain mandatory.

`g5b_owner_acceptances=PASS`
