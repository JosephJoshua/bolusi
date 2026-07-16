# TASK 60 — `canAttempt` has 11 tests, zero callers, and a comment pointing at it: the PIN lockout's test coverage protects the function that isn't the gate

**Status:** done
**Priority:** **MEDIUM** — **no live defect**: the affordance ships correctly via a different path (verified below). The defect is the *coverage*: 11 green tests sit on a decoy, and the code that actually keeps the keys dark has none of them.

## Resolution (implemented — premise confirmed, option 1 taken)

**Premise confirmed in the direction that matters** (T-11). Sabotaged `pinPadState`'s `delayed → 'locked'` arm to `'entry'` (keys go live inside the lockout window). All 10 `expect(canAttempt(…))` sites — isolated into a probe file containing nothing else — stayed **green: 9 passed, EXIT=0**. The finding holds.

**One refinement to the brief, measured:** the *file* was not entirely blind. The full-file run under the same sabotage went **1 failed / 15 passed**, and the single red was `model.test.ts:95` — a pre-existing `pinPadState` assertion, **not** a `canAttempt` one (the `canAttempt` assertions at L91/92 in that same test ran first and passed). So the live path's coverage was not zero; it was **exactly two assertions** (L95 `delayed`, L150 `lockedOut`), each on one fixture. Sabotaging both arms: **2 failed / 14 passed**. The thorough coverage — boundary, rollback, whole-schedule walk — was all on the decoy.

**Option taken: deleted `canAttempt`** (§2.8; its docstring's "belt AND braces" defence is not load-bearing — `assertAttemptAllowed` throws regardless). Its 10 assertion sites were **ported, not dropped**, onto the shipping path via a test-local `keysAreLive(row, now, last) = pinPadState(pinView(…)) !== 'locked'` — a *composition* of the shipped functions mirroring `PinScreen.tsx:96`, never a mirror of their logic. The equivalence is exact: `canAttempt` ⟺ `!locked` on all four branches.

**THE GUARD** (§2.11/T-14): broke `pinPadState`'s `delayed` arm → **4 failed / 12 passed**, incl. the rollback case and the whole-schedule walk (was 1 red before the port). Broke the `lockedOut` arm → **3 failed / 13 passed**. Restored → **16 passed, EXIT=0**. Both arms are load-bearing.

**`PinScreen.tsx:52` fixed** — it now names `PinPad`'s `state='locked'`, traced to the producer (`PinPad.tsx:144` early-returns from `pressDigit` before `onComplete`; `:215` `disabled`; `:216` drops `onPress`).

**Also strengthened:** the totality sweep asserted `expect(pinPadState(view)).toBeTruthy()` — which stayed **green under both sabotages**, because `'entry'` is truthy. It now asserts the security property (keys live IFF not a lockout state) across the whole cross-product, with a `dark > 0` denominator (T-14).

**Sweep filed 63** (the `*_KEY` label-map decoys — same class, 3+ more instances incl. `PIN_MESSAGE_KEY` in this very file) and **64** (wire `knip` as a pinned dep + gate; `knip.json` landed here, the dependency did not).

**A near-miss worth recording (T-15, this task's own thesis):** the replacement comment first written for `PinScreen.tsx:52` said `assertAttemptAllowed` "throws **server-side**". It does not — it is `core/src/auth/lockout.ts`, called by `verifyPin` **on-device**; PIN auth is offline (`api/02-auth §6.5`). An authoritative comment naming an unverified mechanism was nearly shipped **into the fix for an authoritative comment naming an unverified mechanism**. Caught by tracing before writing. This is the fourth time on this project a rule was broken by its own enforcer (§2.11).
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none

<!-- SEC-AUTH-02's enforcement leg is task 14's `assertAttemptAllowed`, not this task; do not claim it. Rationale kept out of the marker line: the grammar takes a comma-separated id list or the literal `none`, and anything else parses as MALFORMED — which the gate only reports for ids that already have an allowlist row, so a malformed marker silently declares nothing (found by impl-61; the orchestrator wrote three of them). -->

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
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).
- **Sweep the class** (T-12) — the valuable half. **What else is exported, tested, and uncalled?** But read the next section first: the orchestrator tried this with grep and it failed in a way you must not repeat.

## The orchestrator already tried the obvious sweep. It failed, and how it failed is this task's best evidence.

Ran the natural check — for each `export function` in `apps/`/`packages/`, count references outside its own file and outside `*.test.ts`; zero ⇒ decoy. Result:

```
CHECKED=462 FOUND=109
```

**109 findings, and `canAttempt` — the case the sweep was written to find — is not among them.** Verified: `grep -c canAttempt decoy.log` → **0**.

**Why:** the only non-test file mentioning `canAttempt` is `PinScreen.tsx` — at **line 52, in the comment**, which is the defect this task exists to fix. `grep` cannot tell a **call** from a **mention**. So the false comment registered as a production reference, and the function it falsely credits was scored as *live*.

**The comment did not merely fool the reviewer. It fooled the automated sweep built to catch what the comment was hiding.** A tool for this class cannot be textual, because the defect *is* text that looks like use.

The other 109 are mostly noise anyway — the denominator is unsound in both directions: test helpers (`test/helpers/*`, `_fixtures.ts`, `_harness.ts`) have zero production callers **by design**, and `packages/core`'s auth functions (`resetPin`, `runEnrollment`, `attemptLockKey`, …) are **built-ahead-of-consumer**, which is the *orphan* class already tracked as tasks 43/49/50 — a different problem with a different fix. A sweep that cannot separate *decoy* from *helper* from *not-yet-wired* has not measured anything.

**So the deliverable is a semantic tool, not a grep.** Use the TypeScript language service — `ts-morph`'s `findReferences`, or **`knip`**, which does exactly this job for a TS monorepo and already understands test-only exports and entry points. **Whatever you use, prove it on the known case first** (T-11/T-14): it must report `canAttempt` as unused. **A sweep that cannot see `canAttempt` is checking nothing** — and it will report a large, confident, useless number while doing it. Then state your denominator and what you excluded, and why.

**Do not hand-classify 109 rows.** Get the tool right, re-derive the list, and expect it to be much shorter.

## Note

Found by review-05 asking *"if this line silently changed, what would notice?"* — the same question that produced tasks 58 and 59. Three findings, one question, one shape.

What makes this one instructive is that **every individual piece is good work.** `canAttempt` is correct. Its 11 tests are thorough — they cover the rollback case, which is a genuinely sharp edge. Its docstring reasons carefully about belt-and-braces. `pinView`/`pinPadState` are correct. `PinScreen` is correct. **There is no bad code here and no bug.** The defect exists only in the *relationship* between the pieces — which is precisely the thing no file-scoped review, no type, and no test can see, because each of them is looking at one piece and every piece is fine.

**And the sweep's failure is the same lesson one layer up.** Task 52's Note already contains the warning — *"trace to a producer, don't count mentions"* — with its own control proving it (*"the dead member looked more alive than the live ones"*). The orchestrator wrote that warning into task 52 and then, sweeping for this exact class, **counted mentions**. That is the third time on this project a rule was authored and then broken by its own author (see §2.1 and the unattributable-`test:rls` green). It is the argument for tooling that cannot make the mistake, over a rule asking people not to.

Also worth carrying, against a "just delete it, it's dead code" reading: **coverage is not a number, it is a mapping.** `model.test.ts` would report excellent coverage of `model.ts` today. Every line of `canAttempt` is exercised. The 11 tests are *counted*. What no coverage tool can report is that they are counted against a function nothing calls — coverage measures *whether a line ran under test*, never *whether the line runs in production*. A decoy with 11 tests raises the number, and it is the number that gets reported to the reviewer.
