# TASK 69 — nothing renders any mobile screen: the model→component wiring is asserted by nothing, which is task 60's decoy one level up

**Status:** done
**Priority:** MEDIUM — **no live bug found**; every screen wires its model correctly today. This is the honest boundary of task 60's fix: 60 moved the lockout coverage onto the code that decides, and **the code that *applies* the decision is still uncovered**.
**Depends on:** —
**Blocks:** the guard in 63
**SEC ids owned by THIS task:** —

## The finding (task 60, stated rather than implied)

Task 60 deleted `canAttempt` and re-pointed its coverage onto `pinPadState`/`pinView` — the functions that ship. Those tests now go red when the mapping breaks (verified: 4 red on `delayed`, 3 on `lockedOut`).

**But nothing asserts that `PinScreen` performs the composition they assume.** `PinScreen` renders:

```tsx
<PinPad state={pinPadState(view)} … />
```

Replace that with `state="entry"` — the keys go live inside every lockout window, the exact bug 60 exists to protect against — and **all 16 tests in `model.test.ts` stay green.** No test imports `PinScreen`.

**Measured, not assumed** (T-11 — this claim was falsified before it was written down). Edited `PinScreen` to `state="entry"`, rebuilt, ran the suite:

```
Tests  16 passed (16)      EXIT=0     <- model.test.ts, with the pad hardcoded live
tsc -b                     EXIT=0     <- "entry" is a valid PinPadState; the type system is happy
```

Reverted; 16 passed. **Both of the repo's standing gates are green on a change that unlocks the PIN pad during a lockout.** Verified: the only `PinScreen` occurrences in `model.test.ts` are *prose in a comment* (T-16: a mention is not a producer — the check for "does a test render this?" produced a match that was a comment, in the very task about a comment being mistaken for a call).

`model.test.ts`'s `keysAreLive` composes `pinPadState(pinView(…))` **the way the screen does**. It is a faithful composition of the shipped functions and it is the right place for the logic's coverage — but a helper that mirrors the screen's wiring cannot detect the screen's wiring changing. Task 60 traded a decoy for real coverage of the decision; the *application* of the decision is still on trust.

**Same for every other screen**: `SwitcherScreen`, `SettingsScreen`, `SyncStatusScreen`, `EnrollmentScreen` all have `model.test.ts` and none has a render test.

## Why it is not already fixed

**There is no render lane.** No `@testing-library/react-native`, no `react-test-renderer` anywhere in the repo; `apps/mobile`'s vitest project has no DOM/native environment. Adding one is a pinned devDependency + environment config + a decision about how much of RN to stub — a real task, and a contended root-manifest edit (§4). Task 60 declined to open it as a side effect of a coverage fix.

## Acceptance

- Decide the lane: `@testing-library/react-native` (pinned, §2.1/08 §2.1) with a vitest environment for `apps/mobile`, or an explicit decision that screens are covered by the on-device suite (L6, testing-guide §2.1) instead — **and if the latter, say what covers the wiring until L6 exists**, because today the answer is "nothing".
- Minimum bar for `PinScreen`: a test that renders it with a `delayed` row and asserts the pad's keys are **disabled** — driving the real component, not the model. **This is the assertion that would fail if `state=` were hardcoded**, and it is the whole point.
- **THE GUARD** (§2.11/T-14): hardcode `state="entry"` in `PinScreen` → the new test goes **RED**; `model.test.ts` stays green (proving the two lanes cover different things, which is the finding). Report "broke X, saw Y fail, reverted".
- Do the same for the other four screens, or state which are deferred and why.

## Note

Worth carrying, because it is the third layer of one mistake. Task 60's brief said the affordance ships via `PinScreen:96 → pinPadState`. **That is a two-link chain and the coverage only ever existed for one link** — first the wrong one (`canAttempt`, zero links), now the right one (`pinPadState`). The remaining link was never mentioned by anyone, in a task whose entire thesis is *"ask what would notice if this line silently changed"*, because the question was asked about the *function* and not about the *wiring*.

`tsc` is not a defence: `state` is typed `PinPadState`, and `"entry"` is a perfectly valid `PinPadState`. This is T-15(a)'s family — a check that is correct and irrelevant.

## CORRECTION (review-60, before merge) — the render lane already EXISTS; do not rebuild it

This task's original framing said there is *no* render lane and one must be built (pinned devDependency + environment + a stub decision). **That is wrong, verified on `main`:**

- `apps/mobile/package.json:44` — `test-renderer: 1.2.0` is an installed pinned devDependency.
- `apps/mobile/vitest.config.ts:54` — the lane already aliases `react-native` → `test/doubles/react-native.tsx` (composing `@bolusi/ui`'s double), and its own header (line 13-14) claims the lane *"CAN: which state a screen renders, which testIDs/roles exist."*
- `packages/ui` already renders components on this exact lane (`test/render.tsx`, `pin-pad.test.tsx`).

**What is missing is not the lane — it is any `apps/mobile` test that mounts a screen on it.** No `apps/mobile/*.test.tsx` renders `PinScreen` (or any screen); `RootNavigator.test.tsx` renders *stub* arms, not the real screens. So the fix is **cheap**: import the existing doubles + `test-renderer`, mount `PinScreen` with a `delayed`/`lockedOut` row, assert the pad's keys are disabled — and do PinScreen **first** because it is the security-adjacent instance. The capability the config header advertises but nothing exercises is the gap.

**Severity stays MEDIUM, not HIGH** (review-60's call, confirmed): PinScreen wires correctly *today* (`state={pinPadState(view)}`), and `assertAttemptAllowed` throws **before the KDF and before `recordFailure`** regardless of what the UI renders — so a broken affordance is UX-only (locked-out taps error out; they neither bypass the gate nor burn attempts). Breadth (the whole screen-wiring layer is unrendered) keeps it above LOW.
