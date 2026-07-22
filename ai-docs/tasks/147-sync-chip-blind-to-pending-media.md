# TASK 147 — a device with 3 photos queued reports "Semua Terkirim" (All Sent): `syncChipState` never reads `pendingMediaCount`, and task 126 propagated that blind spot into the screen's headline

**Status:** in-progress
**Priority:** **HIGH (honesty surface)** — a falsehood in the *reassuring* direction, in the largest text on the one screen whose entire thesis is that a shop owner can believe it. FR/design-system treat sync status as the trust surface; this is the failure mode that costs trust rather than merely annoying.
**Depends on:** 126, 15
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-126 reviewer, 2026-07-22 — **rendered, not reasoned.**

## The finding

Concrete state: `pendingMediaCount: 3, pendingOperationCount: 0`. Actual render (reviewer's temporary probe, run then deleted; worktree confirmed clean afterwards):

```
chip=synced || reassurance=savedHere || title=Semua Terkirim
   || body=0 perubahan belum terkirim || mediaCounter=3 / 3 foto belum terkirim
```

The screen simultaneously says **"All Sent"** in its headline and **"3 photos not yet sent"** in its counter.

**Root cause is pre-existing and deliberate-looking:** `syncChipState` (`apps/mobile/src/screens/sync-status/model.ts:235-241`) never reads `pendingMediaCount`; `reassurance` (`:178`) does. `model.test.ts:234` **pins that asymmetry**, so a test currently guards the blind spot.

**Task 126 did not create it** — before 126 this state read "Perubahan Ditolak" (Rejected Changes), which was wrong in the *other* direction, and 126's fix was correct and independently approved. But keying the title on the chip propagated the chip's blind spot from a small status pill into the headline. Fixing 126 is what made this visible, which is the normal shape of an honest fix.

## The decision this needs
Either `syncChipState` accounts for pending media (and `model.test.ts:234`'s pinned asymmetry is updated with a reason), **or** the title stops being a pure function of the chip. Read `design-system.md` §8.1 and `api/01-sync.md` first, and check `06-media-pipeline.md` — media drains on its own schedule (FR-1138 keeps media and sync independent), so "operations synced, media pending" is a *legitimate* steady state and the right answer may be a distinct state rather than folding media into `synced`. **Do not simply flip `synced` → `pending` when media is queued** without checking that against FR-1138; that would make a normal state look like a problem, which is the mirror-image error.

## FALSIFY (§2.11 — REPORT it)
- Render the exact state above and assert the headline does **not** claim everything is sent while the counter says otherwise. Break the fix → red. Restore → green.
- **Positive controls, both directions:** a genuinely all-clear device (0 ops, 0 media) still reads calm and does NOT report a problem; and a device with pending *operations* still reports what it already did. Without both, the fix can be "always say pending", which is the mirror error.
- Also witness the chip and the title together — see task 144 item 3: no test currently asserts the *chip's* rendered state, only the title, so "chip and title are one verdict" is by-construction but unobserved. `packages/ui/src/shell/SyncChip.tsx:87` already exposes `testID={\`ui.syncChip.icon.${state}\`}`.
