# TASK 190 — shrink the enum-mirror-parity gate to the one mirror that is still forced

**Status:** todo
**Depends on:** 193
**Blocks:** —
**SEC ids owned by THIS task:** none.

**Filed by:** the 2026-08-30 complexity/over-engineering audit (owner-approved cut-list, Tier 1 #3).

## Goal

`packages/test-support/src/enum-mirror-parity.test.ts` (107 lines) guards **two** mirrors via source-text regex extraction plus `toHaveLength(2)` denominator bookkeeping (T-14):

- **Arm (a): ui ↔ schemas** — `OPERATION_SYNC_STATUSES` re-declared in `packages/ui/src/components/SyncStatusChip.tsx` because ui may not import schemas.
- **Arm (b): the Hermes/zod-bundle mirror** in test-support — genuinely forced (test-support must not drag zod into the RN bundle).

Once **task 193** lets ui import `type OperationSyncStatus` from schemas, arm (a)'s literal mirror is **gone** — delete arm (a). Reduce the file to **one real parity check** for arm (b) (~15 lines), and drop the source-regex + denominator ceremony where a direct import/assert will do.

## Must preserve (do NOT cut)

- **Arm (b), the Hermes/zod-bundle mirror check** — that boundary is real. Keep a check that reds if the bundle mirror diverges from its source of truth. Prefer a direct value/type comparison over source-text regex if the module graph allows.

## Docs to read

- `ai-docs/08-stack-and-repo.md` §3.3 (package boundary matrix); `ai-docs/testing-guide.md` T-14 (denominator floor).

## Files / modules touched

- `packages/test-support/src/enum-mirror-parity.test.ts` (shrink 107 → ~15).
- `packages/ui/src/components/SyncStatusChip.tsx` — arm (a)'s mirror is removed by task 193; this task removes the corresponding gate arm.

## Acceptance

- The gate checks exactly the mirror(s) that are still structurally forced; the ui/schemas arm is gone (its mirror no longer exists).
- No `toHaveLength(N)` denominator bookkeeping remains unless it guards a real, still-present set.

### Falsification (§2.11)

1. **Break the surviving mirror (b)** — diverge the bundle mirror from its source → the ~15-line gate must red naming the divergent member. Restore → green.
2. **Prove arm (a)'s deletion is safe** — after 193, ui imports the type and has no literal to drift; demonstrate there is nothing for arm (a) to protect (the mirror it checked does not exist). Report "removed arm (a); the mirror it guarded was deleted by 193; arm (b) falsified red-then-green."
