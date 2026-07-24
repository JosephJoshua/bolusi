# TASK 169 — quarantined ops are surfaced by a screen that can never be given one: no client table persists a held-out pull batch

**Status:** todo
**Priority:** MEDIUM — a silent hole in the honesty surface. api/01-sync §4 holds a failing batch OUT of view on purpose; 05 §8's doctrine is that nothing is silent. Today the holding-out happens and the telling never can.
**Depends on:** 15, 130
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** task 130's implementer, 2026-07-23, while making the other three §8.4 inputs real reads.

## The finding

`SyncStatusScreen` ships a quarantine section (`sync-quarantine`, `sync.quarantine.title` /
`sync.quarantine.body`: *"Beberapa perubahan dari perangkat lain gagal diverifikasi, jadi belum
ditampilkan. Laporkan ke pemilik toko."*). `model.ts` computes a `quarantined` `SyncProblem` from
`SyncStatusInput.quarantined`. Both are tested.

`shell-inputs.ts` passes `quarantined: []`. Task 130 turned the three literals beside it
(`pendingOperationCount`, `rejected`, `media`) into real database reads and left this one alone,
because there is nothing to read: **`grep -rn quarantin packages/db-client/src` finds no table and no
column**, and nothing in `packages/core/src/sync` writes one. The pull path holds a batch out; the
fact that it did survives nowhere.

So the section is unreachable on every device in every state — the same shape as the rejected list
before 130, but one layer deeper: there the input was a literal over data that existed, here the
data itself is never recorded.

**State it the way that matters: the section and its model tests are green BECAUSE the data is
unreachable, not because the behaviour is correct.** `model.test.ts` builds a `quarantined: [...]`
array by hand and asserts the section appears — a true statement about a value that no code path in
this client can ever produce. That is the same class as the inert-mechanism cluster (133–140) and as
CLAUDE.md §2.11's i18n gate, which was green precisely because the keys it judged were invisible to
it. A test whose input cannot occur is not covering anything; it is describing a hypothetical.

## Related, and deliberately not folded in

`model.ts:214` already carries a "NOTE FOR REVIEW — a real gap" that `BannerCause` (packages/ui) has
no `quarantined` member, so quarantined ops cannot raise the ambient banner api/01-sync §4 implies.
That note assumes the section itself works. It does not. Fix the persistence first; the banner is a
contended-package change (CLAUDE.md §4) and can follow.

## Deliverable

- Decide where a held-out batch is recorded (10-db-schema change → migration, serialized globally),
  what identifies it (api/01-sync §4's batch/device granularity), and when it is cleared.
- Write it from the pull path, read it in `bootstrap/sync-status-reads.ts` beside the other three.
- Then reconsider `BannerCause`.

## Falsify

A COMPOSED test on the real `Root` (see `test/live-shell-dead-controls.test.tsx`): a pull whose batch
fails verification → the quarantine section renders on Sync Status. Break the write and watch it go
red. A model-level test proves nothing here — a model test over a hand-built `quarantined: [...]`
array is exactly what has been green while the array could never be non-empty.
