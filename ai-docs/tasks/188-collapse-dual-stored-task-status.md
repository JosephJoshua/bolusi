# TASK 188 — collapse dual-stored task Status to a single source; delete the ledger drift-guard it necessitated

**Status:** todo
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.

**Filed by:** the 2026-08-30 complexity/over-engineering audit (owner-approved cut-list, Tier 1 #1).

## Goal

Task Status is stored **twice** — the `_index.md` row cell **and** each file's `**Status:**` line (CLAUDE.md §2.6). Because two stores can disagree, a whole apparatus exists only to keep them honest: `scripts/task-status.mjs` (234) writes both, and an append-only ledger + gate — `packages/test-support/src/ledger.ts` (259) + `ledger.test.ts` (231) + `task-status.test.ts` (316) — is the task-66 backstop that reds on hand-edits that skip the writer. That is **~1,345 LOC guarding a drift class that only exists because there are two stores.**

Make Status **single-source** so the drift class — and its guard — cannot exist:

- `_index.md` is already declared canonical (CLAUDE.md §2.6) → make it the **sole writable store**. The per-file `**Status:**` line becomes a **pure projection** with exactly one writer (regenerated from the index, never hand-edited), or is dropped entirely — the implementer picks, whichever keeps task files readable without a second source of truth.
- `pnpm task:status <id> <status>` shrinks to a ~20-line single-store writer (still refusing unknown id/status).
- **Delete the ledger history subsystem** (`ledger.ts` + `ledger.test.ts`) — the append-only audit log is the heaviest ceremony and it never *prevented* drift (the dual-write did); it was history. If a parity check between projection and index is still wanted it is ~15 lines, not 316.

## Must preserve (do NOT cut)

- **Id-allocation against origin/main** in `scripts/task-new.mjs` (task 173 — the concurrent-branch collision fix, 3× in one session). Keep it; only drop its dual-**write** half.
- The **refuse-unknown-id / refuse-unknown-status** validation.
- The invariant that "what's left" has **one truthful answer** — collapsing to one store makes this *structural* (a single store cannot disagree with itself) instead of gate-enforced.

## Docs to read

- CLAUDE.md §2.6 (canonical index), §5 (the `pnpm task:status` writeback contract — this task rewrites that paragraph), §2.11.
- `ai-docs/tasks/_index.md` header (serialization notes).

## Files / modules touched

- `scripts/task-status.mjs`, `scripts/task-new.mjs`
- `packages/test-support/src/ledger.ts`, `ledger.test.ts`, `task-status.test.ts` (delete / shrink)
- CLAUDE.md §5 (rewrite the dual-store paragraph)
- `ai-docs/tasks/*.md` — if the per-file line is dropped/projected, this is a mechanical pass over ~190 files: **script it**, one commit.

## Acceptance

- Status has exactly one writable store; the other representation (if kept) is a deterministic projection with one writer.
- `pnpm task:status` still refuses unknown id/status; `pnpm task:new` still allocates against origin/main.
- The removal is **atomic**: the second store and its ledger gate go in the same change — never a window with one store and no guard.

### Falsification (§2.11 — this deletes a guard; prove the deletion is safe, not just green)

1. **Break id-allocation** — force two branches to allocate the same id → `task:new` must still red (task 173's guarantee survives).
2. **Corrupt the single store** — hand-edit a status to an illegal value → the single writer/reader refuses or surfaces it; there is **no second store** for it to silently drift from.
3. **Prove the ledger gate is now vacuous** — after collapse, the class it caught (index-cell ≠ file-line) cannot be constructed. Demonstrate that deleting `ledger.ts` removes protection of *nothing reachable*, per §2.11 "a guard whose failure mode is silently-checks-nothing." Report as "removed guard X; showed the class it protected is now unconstructable; reverted-check confirms."
