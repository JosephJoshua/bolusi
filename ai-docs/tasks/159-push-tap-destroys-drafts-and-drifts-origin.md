# TASK 159 — a push-notification tap is the LAST producer of the draft-loss class task 145 closed — and the same tap drifts the switcher's back-origin

**Status:** blocked
**Priority:** **MEDIUM** — same silent data loss as task 145 (a dirty note editor unmounts with no ConfirmSheet), but via the one producer 145 did not cover.
**Depends on:** **155 (HARD PREREQUISITE — see the ruling below)**, 145 (the discard gate), 135 (the push router that produces the tap), 143 (the switcher `origin`)

**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-145 reviewer (MEDIUM finding 1) + the task-145 implementer's deferred item, 2026-07-22.

## Leg A — a push tap destroys a dirty draft (traced end to end, T-16)
`App.tsx:139-141` applies a deep link with a bare `setRoute(pushRoute.route)`, **bypassing `leaveHome`** (145's gate). `resolvePushShellRoute` (`apps/mobile/src/push/router.ts:63-69`) returns `'syncStatus'` for **every** resolvable tap, so the route leaves `home`, `NotesHome` unmounts, and the editor's `title`/`body`/`mediaRef` are destroyed with no confirm.

**Producer chain (verified, not a mention):** `apps/mobile/index.ts:385` binds `expoPushRouter` → `Root.tsx:534-545` subscribes to warm taps AND the cold-start tap → `setPushRoute` → `App.tsx:140`.

**Failing input:** open the note editor, type a body, receive/tap any push notification → draft gone, no ConfirmSheet.

## Leg B — the same tap drifts the switcher origin (deferred from 145)
A push arriving while `switching` is true calls `setRoute` unconditionally, so the switcher's `origin` drifts exactly like the sync-chip vector 145 fixed — a later back lands on the pushed route instead of where the switch was opened. 145 fixed the chip vectors with `if (!switching)`; the push path was left because it needs the same ruling as Leg A.

## RULED 2026-07-23 — D23 §1: option (b), PRESERVE THE DRAFT THEN NAVIGATE

The ruling this task was filed to obtain has landed. **The tap must always navigate, and the draft
must survive it.** Option (a) — gating behind the ConfirmSheet — was the orchestrator's
recommendation because it ships now with no new machinery; **the owner ruled for (b) instead**,
accepting the dependency it creates. Option (c) was not taken.

The three options are preserved below as the record of what was weighed. **They are no longer a
choice** — do not re-open them.

- **(a) Gate it** — a push tap raises the ConfirmSheet like any other chrome navigation. Consistent with 145; the user never silently loses work. Cost: a notification tap sometimes "doesn't work" until the user answers a prompt. *(Recommended by the orchestrator; NOT ruled.)*
- **(b) Let it through, but preserve the draft** — navigate immediately (notifications feel broken if they don't), but persist the draft into the retention path first (task 155's workspace seam) so nothing is lost. Best UX, needs 155. **← RULED.**
- **(c) Defer the push while dirty** — hold the pending route and apply it after the user resolves the editor. *(Not ruled.)*

**Consequences of the ruling:**
- **Task 155 is now a HARD PREREQUISITE.** (b) needs a retention path that something actually writes
  into; 155 is the task that makes `updateWorkspace` reachable from a screen. 155 was `todo` and
  unstarted when this was ruled, and its priority was raised to HIGH accordingly. **This task is
  `blocked` until 155 lands.**
- **Do NOT implement this partially.** "Navigate and hope" — routing the tap without retention — ships
  exactly the silent draft-loss the ruling exists to remove, while *looking* like the ruling was
  honoured. That is strictly worse than today's state, which at least fails visibly to anyone testing it.
- The draft-loss class task 145 opened is now closed by **retention**, not by prompting. A ConfirmSheet
  on a notification tap is explicitly not the answer.
- **Leg B is unaffected by the ruling** and can be reasoned about independently: either apply the same `!switching` guard, or freeze `origin` at switch-start (a `ZoneInput` field in the contended `zone.ts`).

## FALSIFY (§2.11 — once the ruling lands)
- Reproduce Leg A first (dirty editor + push tap → draft gone, no sheet) and lead with it. After the fix, the chosen behaviour holds and the draft is never silently destroyed.
- **Positive control:** a push tap with a CLEAN editor still navigates immediately with no prompt (whatever the ruling, a clean editor must not be nagged).
- Leg B: home → avatar → push arrives → back → lands where the switch was opened, not the pushed route.

## Two LOW items from the same review (fold in while here)
1. **The discard gate is duplicated** — `NoteEditor.tsx:225-236` (`requestLeave`, header back) and `:244-253` (the inline body in the registration `useEffect`, used by hardware back + chrome) are two copies of the same `if (dirty) {…} proceed()`. Identical today, nothing keeps them so. Have the effect call `requestLeave` through a ref so there is literally one body. (Same shape one level up: the editor's `onCancel` and the surface's `backTo` are separately defined and happen to agree.)
2. **Hardware back while the ConfirmSheet is open rewrites the destination** — the press is consumed and the sheet stays (no exit, no data loss — good), but it re-enters the guard and replaces `pendingLeave` with `backTo`, so confirming lands on the notes list instead of the User Switcher the user tapped. Note "hardware back does not dismiss the sheet" matches the enrollment wizard's existing behaviour, so that half is a repo-wide pattern, not a regression.

## Coverage gaps noted by the reviewer (not defects — their probes passed against shipped code)
The shipped suite covers the avatar + language chip as chrome-leave paths but **not the sync chip**, and has no clean-editor positive control for the language chip. Worth adding when you touch this.
