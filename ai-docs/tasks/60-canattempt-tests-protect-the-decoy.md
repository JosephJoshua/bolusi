# TASK 60 — `canAttempt` has 11 tests, zero callers, and a comment pointing at it: the PIN lockout's test coverage protects the function that isn't the gate

**Status:** todo
**Priority:** **MEDIUM** — **no live defect**: the affordance ships correctly via a different path (verified below). The defect is the *coverage*: 11 green tests sit on a decoy, and the code that actually keeps the keys dark has none of them.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** — (SEC-AUTH-02's enforcement leg is task 14's `assertAttemptAllowed`, not this; do not claim it)

## The finding (review-05 coverage sweep)

`apps/mobile/src/screens/pin/model.ts:73` exports `canAttempt(row, now)`. It has:

- **11 assertions across `model.test.ts`** (lines 47, 54, 91, 92, 108, 117, 129, 130, 149, 166) — the delay window, the clock-rollback case, the lockout case;
- **zero production callers.** `grep -rn "canAttempt" apps/ packages/` returns its definition, the tests, and **one comment**;
- **a docstring claiming a role it does not fill**: *"this is the AFFORDANCE — what lets the screen keep the keys dark instead of accepting taps that are guaranteed to throw… The reverse — a screen that fires a verify into a closed window — is what this prevents."*

and `PinScreen.tsx:52`, on the `onSubmit` prop:

```ts
/** Fires only when the model permits an attempt — see `canAttempt` in model.ts. */
readonly onSubmit: (pin: string) => void;
```

**That comment is false.** `canAttempt` has no bearing on when `onSubmit` fires.

## What actually holds (verified — this is why it is MEDIUM, not HIGH)

The affordance **is** delivered, by a path that never mentions `canAttempt`:

```
PinScreen:96   <PinPad state={pinPadState(view)} … />
model.ts:118   pinPadState(view) → 'locked' for both 'delayed' and 'lockedOut'
```

`pinView` and `canAttempt` both read `derivePinAuthState(row)` and the same `notBefore`, and their delay logic agrees exactly (`canAttempt` false ⟺ `now < notBefore` ⟺ `pinView` returns `delayed`). **The keys are dark.** No user-facing bug. Do not "fix" this by wiring `canAttempt` in — that adds a second gate where one already works (§2.8).

## Why it still matters: the tests point at the decoy

Break `pinPadState`'s `delayed → 'locked'` mapping — the line that actually keeps the keys dark — and **all 11 `canAttempt` tests stay green.** They are the most lockout-looking tests in the file. They read as coverage of exactly the property that would have just broken, and they cannot see it.

That is CLAUDE.md §2.11's class in its purest form yet: not a guard that checks nothing, but **a guard that checks something real, correctly, that nothing depends on.** Its subject is genuine, its assertions are sound, its failure mode is that the code under it was never on the path. And it is *worse* than an empty test, because an empty test looks suspicious and this one looks diligent.

The `PinScreen.tsx:52` comment completes the trap: it tells the next reader the gate is `canAttempt`, so when they go looking for the lockout's coverage they find 11 tests, on the named function, all green — and stop. **Same shape as tasks 58 and 59: the comment is what stops the checking.** Here it is doing it to the *tests*.

## Acceptance

**Observable done-condition:** exactly one path gates the pad, its tests fail when it breaks, and no comment names a function that isn't on the path.

- **Confirm the premise yourself first** (T-11 — and confirm it in the direction that matters): break `pinPadState`'s `delayed → 'locked'` case, run `model.test.ts`, and **watch the 11 `canAttempt` tests stay green**. That observation is the finding; if they go red, the premise moved — stop and report.
- **Decide and say which** — do not do both:
  - **Delete `canAttempt`** and its 11 tests, and **re-point the coverage at `pinPadState`/`pinView`** (the path that ships). The delay-window, clock-rollback, and lockout cases are **good tests of a real property** — they must survive the move; port them, do not drop them. This is the recommendation: it satisfies §2.8, and the "belt AND braces" defence in its docstring is not load-bearing (task 14's `assertAttemptAllowed` is the enforcement and throws regardless — the docstring says so itself).
  - **Or wire it** — only with a stated reason why two client-side gates beat one, given 14's server-side gate already refuses. The bar is high; §2.8 is against you.
- **Fix `PinScreen.tsx:52` either way.** It must name what actually gates `onSubmit` (`PinPad`'s `state='locked'` via `pinPadState`), or say nothing. A comment naming the wrong function is worse than no comment — that is this task's whole thesis.
- **THE GUARD** (§2.11/T-14): after the move, break `pinPadState`'s `delayed` case → the ported tests go **RED**. Report the falsification ("broke X, saw Y fail, reverted"), not "tests pass."
- **Sweep the class** (T-12) — this is the valuable half, and the reason this task is worth doing at all: **what else is exported, tested, and uncalled?** A repo-wide check for `export`ed functions in `apps/`/`packages/` whose only references are their definition + a `.test.ts` would find every other decoy in one pass. Report the list. If it is short, fix it here; if it is long, file it. **Consider making it a lint rule** — this class is mechanically detectable, which is more than can be said for tasks 58 and 59.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Found by review-05 asking *"if this line silently changed, what would notice?"* — the same question that produced tasks 58 and 59. Three findings, one question, one shape.

What makes this one instructive is that **every individual piece is good work.** `canAttempt` is correct. Its 11 tests are thorough — they cover the rollback case, which is a genuinely sharp edge. Its docstring reasons carefully about belt-and-braces. `pinView`/`pinPadState` are correct. `PinScreen` is correct. **There is no bad code here and no bug.** The defect exists only in the *relationship* between the pieces — which is precisely the thing no file-scoped review, no type, and no test can see, because each of them is looking at one piece and every piece is fine.

Also worth carrying, against a "just delete it, it's dead code" reading: **coverage is not a number, it is a mapping.** `model.test.ts` would report excellent coverage of `model.ts` today. Every line of `canAttempt` is exercised. The 11 tests are *counted*. What no coverage tool can report is that they are counted against a function nothing calls — coverage measures *whether a line ran under test*, never *whether the line runs in production*. A decoy with 11 tests raises the number, and it is the number that gets reported to the reviewer.
