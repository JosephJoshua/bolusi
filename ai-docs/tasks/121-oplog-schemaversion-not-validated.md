# TASK 121 — the server accepts an op claiming ANY `schemaVersion`: `deriveOpRegistry`'s `resolve(type)` ignores the version and validates every push against the ONE current payload schema

**Status:** todo
**Priority:** MEDIUM — a real op-version gate hole. Not currently exploited (one version per type exists today), but it becomes live the moment any op type has a second version, and it fails in the worst place: acceptance succeeds, then the applier throws at FOLD time, on an op that is already in the signed, append-only log (05 §7 — old ops never disappear).
**Depends on:** 07 (op-log pipeline), 11 (module contract / registry)
**Blocks:** any op-type version bump (e.g. task 120's `note_created` v3)
**SEC ids owned by THIS task:** none.
**Filed by:** the orchestrator, 2026-07-21, from impl-120's trace during task 120 (flagged, correctly not folded into that slice).

## The finding (verified)

`apps/server/src/deps.ts` `deriveOpRegistry` declares a `resolve(type, schemaVersion)`-shaped contract, but the implementation at `deps.ts:117` is literally `resolve(type) {` — **`schemaVersion` is ignored**. Every pushed op is validated against the ONE current payload schema for its type. So:

- An op claiming `schemaVersion: 99` whose payload happens to satisfy the CURRENT schema is **ACCEPTED** at push (no `SCHEMA_INVALID`).
- The applier then dispatches on the claimed version, finds no handler for 99, and **throws at fold time** — after the op is durably in the log and replicated.

The registry side is deliberately strict (`packages/core/src/module/registry.ts:88` `schemaVersionFor(type): number | undefined` — one current version per type, with a comment explaining a handler must not be able to "emit an op claiming a shape it does not have, which the applier would then mis-fold forever"). The SERVER-side validation does not honour that intent.

## Deliverable
- Make the server's op validation actually key on the claimed `schemaVersion`: an op whose `schemaVersion` is not a version the registry knows for that type must be **rejected at push** with the documented code (`SCHEMA_INVALID` / `UNKNOWN_TYPE` per `05 §8` / `api/01 §3` — pick the one the spec names for an unknown version and cite it), never accepted-then-thrown-at-fold.
- If the design intends forward-compat (accept future versions and re-fold later), say so explicitly and implement THAT deliberately — but do not leave "accepted then throws at fold" as the behaviour, which is neither.

## FALSIFY (§2.11 — REPORT it, real PG16, attributed)
- Push an op with `schemaVersion: 99` and an otherwise-valid current payload → BEFORE: accepted (200/`accepted`), then the applier throws at fold. Lead with that reproduction.
- AFTER: the push is rejected with the spec'd code and the op never enters the log. Positive control: a correct current-version op still accepts and folds.
- Break the version check → the reproduction is accepted again → RED → restore → green.

## Constraints
Touches `apps/server/src/deps.ts` + the op-log pipeline validation + its tests. Coordinate with any in-flight op-version work (task 120 bumps `note_created` to v3 — this gate must not spuriously reject a LEGITIMATE new version; the fix is to consult the registry, not to hardcode a number).

## Note
Filed from task 120's boundary analysis. The registry already encodes the right intent; only the server's `resolve` forgot to read it. Classic "the contract's signature says one thing and the implementation ignores a parameter" — invisible to types because the extra arg is simply unused.
