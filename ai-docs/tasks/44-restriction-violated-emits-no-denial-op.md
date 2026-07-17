# TASK 44 — `restriction_violated` denials emit no audit op: the audit is weakest where the attack is worst
**Status:** in-progress
**Priority:** P2 — **the only LOSSY finding on the auth surface.** A missing applier can be backfilled from the log later (task 43); **an op never emitted is data that does not exist.**
**Depends on:** 14

## Goal

Make `restriction_violated` denials emit `auth.permission_denied`, and resolve the spec tension that currently makes them not.

**The finding** (review-04, task 14 review — call sites `pin-flows.ts:107-113`, `:297-306`, `:327-332`; task 14's own tests pin the absence at `pin-flows.test.ts:159`, `:197`):

`restriction_violated` is an explicit member of the closed `DenialReason` enum (`02-permissions.md:186`) **whose only carrier is the `auth.permission_denied` op** — and nothing emits one for it. The asymmetry is inverted from what you'd want:

| denial | audited? |
| ------ | -------- |
| staff denied because they **lack** a permission (evaluator denial) | **yes** — via the runtime's DenialEmitter (`pin-flows.ts:142-143`) |
| staff denied because they **targeted the `main_owner`'s PIN** (restriction) | **no** |

**The audit is weakest exactly where the attack is most serious.** A staff member fumbling a permission they never had is logged; a staff member attempting to reset the owner's PIN is not.

**It is also the fourth orphan of this session.** Task 09's review recorded `restriction_violated` as *"in the closed enum but provably never produced by this algorithm (§5.4 is tasks 13/14)"* — deferred to 13/14. Task 13 is server-side. Task 14 doesn't emit it. So no one does, and the enum member is currently **dead spec**. (Same shape as the permission registry, the schemas auth DTOs, and the auth appliers: specified, half-built, no owner — failing by being *absent* rather than broken.)

## The ruling (orchestrator, 2026-07-15): it must emit. Doc-first.

**This is not genuinely ambiguous — `28-security-sweep.md` already settles it.** Task 28's acceptance requires, for the dangerous-permission matrix:

> *"privileged-target rule: `store_owner` PIN reset targeting the `main_owner` holder denied … **Every denial asserts `403`/`PERMISSION_DENIED` and a denial operation logged (02 §7, FR-1045)** — never an empty-200."*

The privileged-target denial **is** `restriction_violated`. The release gate is specified to read back an op that is never written. So one of {code, spec} must move, and task 28 + FR-1045 + the enum's existence all point the same way: **the op must be emitted.**

**The real tension is §7's "Emitted by" line** (`02-permissions.md:178`): *"The permission runtime itself, at the single enforcement point (§4). Bypasses the command layer (it IS the command layer); one of the five runtime-emitted types (§4). Never recursive."* A handler-internal restriction check is not the enforcement point, so emitting from the handler would contradict §7 as written.

**Resolve it by routing, not by exception:** the handler's restriction denial goes **through the same `DenialEmitter`** the enforcement point owns, so there is still exactly one emission path and `auth.permission_denied` remains one of the five sanctioned runtime emissions (04 §5.1, a closed set task 10 pins to the doc). Then §7's claim stays true — the runtime emits it; the handler only *declares* the denial. That keeps the invariant task 10 built (`#requirePermission` never lets a caller supply an emitter — the emitter is constructed internally precisely so nobody can turn the audit off from outside).

**Doc-first** (CLAUDE.md §4 — spec changes are their own task; this is that task): amend `02-permissions.md` §7's "Emitted by" to state that the enforcement point emits for **evaluator denials and handler-declared restriction denials alike, both through the runtime's emitter**, then change the code. Do not edit the spec as a side effect of the fix — do it deliberately, first.

## A second audit gap in the same cluster — decide it here (from task 14's F1 fix, 2026-07-15)

**A crash between the pessimistic lockout write and the emission leaves the user correctly locked with NO `auth.pin_locked_out` op.** Task 14's F1 fix banks the failure *before* the KDF (so a kill mid-verify can't buy a free guess) and emits the lockout op only *after* the KDF confirms failure (so a user whose 10th PIN was **correct** is never falsely announced as locked — that ordering is deliberate and right). The window between them is small but real: **fail-closed on the security property, a gap in the audit trail.**

Same shape as the `restriction_violated` gap above — *the lock happened, the record didn't* — so rule on both together rather than twice.

The option task 14 identified and correctly declined to implement unilaterally: **reconstruct on the next gate check** (if the row says `locked_out` and no lockout op exists for this lockout episode, emit it then). That is new behaviour and needs a decision, not a quiet fix. Weigh it against: (a) the op's `timestamp` would then lie about when the lock happened, or must carry the original — which the row would need to store; (b) an emission triggered by a *read* path is a new emission trigger, and `auth.pin_locked_out` is one of the five sanctioned runtime emissions (04 §5.1, a closed set) — the trigger set is not obviously as closed as the type set; (c) doing nothing means the audit under-counts lockouts by exactly the crash rate, which for an offline-first app on cheap Android hardware is **not** negligible.

## Docs to read

- `02-permissions.md` **§7** (the denial op: payload, throttle, and the "Emitted by" line this task amends), **§5.4** (restrictions), **§12** (the authz matrix + the privileged-target rule), :186 (the `DenialReason` closed enum).
- `ai-docs/tasks/28-security-sweep.md` — the acceptance line that settles the ruling; task 28 is the consumer.
- `packages/core/src/auth/pin-flows.ts` :107-113, :297-306, :327-332 — the three call sites. `pin-flows.test.ts:159`, `:197` — the tests that currently pin the *absence*; they must invert.
- `packages/core/src/runtime/execute.ts` — `#requirePermission` + the internally-constructed `DenialEmitter` (the path to route through; note *why* it isn't injectable).
- `04-module-contract.md` §5.1 — the five sanctioned runtime emissions (closed set, pinned to the doc; `auth.permission_denied` is already a member — you are not adding a type).
- `security-guide.md` §SEC-AUTH-11 (the privileged-target semantics).

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `ai-docs/02-permissions.md` §7 — **first**.
- `packages/core/src/auth/pin-flows.ts` (3 call sites) + its tests. **`@bolusi/core` is contended (CLAUDE.md §4)** — serialize.

## Acceptance

**Observable done-condition:** a `store_owner` attempting a PIN reset against the `main_owner` holder is denied **and** an `auth.permission_denied` op with `reason: 'restriction_violated'` is in the log — which is exactly what task 28's matrix will assert.

- **Prove the gap first** (T-11): drive the privileged-target denial today, assert it throws, and show **no denial op was emitted**. That absence is the bug. (Task 14's `pin-flows.test.ts:159`/`:197` currently assert that absence *as correct* — those tests invert.)
- **Doc-first**: amend §7's "Emitted by" before touching code, and say why in the commit.
- **Route through the runtime's emitter** — do not build a second emission path, do not make the emitter injectable (task 10 constructed it internally on purpose: *"injecting a pre-built emitter would let a caller supply one whose port silently drops the op, turning the denial audit trail off from the outside"*). §2.8: one implementation.
- **The payload is the six fields §7 specifies** (`permissionId`, `surface`, `target`, `reason`, `scopeStoreId`, `suppressedRepeats`) with `reason: 'restriction_violated'` and `target` naming the privileged target. **Assert the outcome, not the mechanism** (task 10/11's lesson): assert *"the op with reason=restriction_violated is readable"*, not *"the emitter was called."*
- **The deny must not become conditional on the emit.** Task 10's ordering is load-bearing and reviewed: the decision is computed **before** the emit, the emit is wrapped in `try/catch`, and the `throw` sits **outside** that catch — so a failed audit can never un-deny. Preserve exactly that shape here. A `catch` around a security decision is where fail-closed goes to die; the catch wraps the **audit**, not the **decision**.
- **Falsify** (§2.11): break the emission, watch the new test go red; restore. And confirm the deny still happens when the emitter throws (the audit failing must not authorize anything).
- **Sweep the class** (T-12): `restriction_violated` has three call sites *in pin-flows* — is it declared anywhere else, now or by 02 §5.4's definition? Every path that denies for a restriction emits, or you have re-created this bug in a place nobody enumerated. Name the count (T-14).
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Found by review-04 while judging a deviation task 14 had *self-reported* — task 14 flagged the asymmetry as a known gap rather than shipping it silently, and the reviewer then sized it correctly: **P2 and lossy, outranking the missing appliers (task 43)**, because a projection can be rebuilt from the log but an op that was never written is gone.

Note task 14 was right not to fix it: emitting from a handler contradicts §7 as literally written, so the fix needed a spec ruling first. Reporting the tension instead of quietly resolving it in code is the behaviour we want — the alternative is a spec and an implementation that disagree, with the code silently winning.
