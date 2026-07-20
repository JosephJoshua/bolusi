# TASK 108 — `platform.acknowledgeConflict` is dead in the real runtime: its `ctx.query(listConflictsQuery)` read seam has no `name`, so the command throws `VALIDATION_FAILED: query has no name`

**Status:** todo
**Priority:** **HIGH** — the `acknowledgeConflict` command (the ONLY production write path for the `surfaced → acknowledged` Conflict transition, 03 §7) throws on every real invocation. No LIVE user impact yet only because no UI wires the command; it bites the moment the conflicts screen ships. The bug is invisible to the existing test because that test STUBS the query (T-11/T-15: the oracle was interrogated, not the mechanism).
**Depends on:** 17
**Blocks:** — (must be resolved before the conflicts/acknowledge UI goes live)
**SEC ids owned by THIS task:** none

## The finding (found by impl-26 wiring CHAOS-07's acknowledge leg through the real command)

`packages/core/src/platform/queries.ts` `listConflictsQuery` is declared **without a `name`**:

```ts
export const listConflictsQuery = {
  permission: PLATFORM_PERMISSION.conflictView,
  input: listConflictsInput,
  handler: listConflictsHandler,
} as const;
```

`acknowledgeConflictHandler` (`platform/commands.ts`) reads its precondition through this exact object: `await ctx.query(listConflictsQuery, {...})`. The query runtime (`packages/core/src/query/execute.ts:96`) requires a `name` on the query it is handed:

```ts
const target = executable.name;
if (typeof target !== 'string' || target.length === 0) {
  throw new DomainError('VALIDATION_FAILED', { issue: 'query has no name' }, 'query has no name — defineModule fills it from the manifest key (04 §6); a denial op needs it for `target` (02 §7)');
}
```

`defineModule` does **not** mutate — `withNames` (`module/define-module.ts:237`) attaches `name` to a **copy** (`platformModule.queries.listConflicts`), so the raw `listConflictsQuery` the handler imports still has none. The notes module solved exactly this: `getNoteQuery` (`packages/modules/src/notes/queries.ts:220`) **self-carries** `name: 'getNote'` with a comment — "Carries its own `name` so `editNoteBody` / `archiveNote` can read through it via `ctx.query` (the query runtime needs the name; 02 §7)". Platform's `listConflictsQuery` is the same shape (command reads through it) but was not given the same `name` — a real inconsistency.

**Why no test caught it (the §2.11 class):** the only test that runs `acknowledgeConflict` is `packages/core/test/platform/commands.test.ts`, and it **stubs** the read — `fixture.queries.stub('platform.conflict_view', {...})` — so `ctx.query(listConflictsQuery)` never reaches the runtime's name check. The command's read seam has therefore **never** executed through the real query runtime. Reproduced end-to-end by `packages/harness/scenarios/chaos-07-conflicts.test.ts`, which drives the real runtime.

## The fix

Add `name: 'listConflicts'` to `listConflictsQuery` (mirroring notes' `getNoteQuery`). One line. `defineModule` re-attaches the same name from the manifest key, so the self-carried name and the derived one agree by construction.

## Acceptance

- `listConflictsQuery` self-carries `name: 'listConflicts'`.
- **A test executes `acknowledgeConflict` through the REAL query runtime** (no `queries.stub` for the read) — a surfaced conflict in the projection, then `acknowledgeConflict`, asserting the emitted `platform.conflict_acknowledged` op. **Falsify (§2.11):** delete the `name` → the test RED with `VALIDATION_FAILED: query has no name`; restore → green. This closes the stub blind-spot that hid the bug.
- Consider a meta-check that every manifest query read via `ctx.query` from a command handler self-carries a `name` (the notes/platform pattern), so a third query cannot repeat this.
- `pnpm typecheck` / `pnpm lint` / `pnpm test` green — read the output (§2.1).

## Note
Filed from task 26 (CHAOS-07). The harness authors the ack op via the blessed `ChainBuilder` (test-support, production `signOp` path) to exercise the REAL server + client `conflictAcknowledgedApplier` `surfaced → acknowledged` transition — the subject of testing-guide §3.6 (iii) — so CHAOS-07 does NOT depend on this fix. Once fixed, the harness can additionally drive the ack through the real command. This is a `@bolusi/core` platform-module defect (task 17's surface), filed rather than worked around in the harness (T-7).
