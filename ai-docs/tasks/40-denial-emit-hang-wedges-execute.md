# TASK 40 — a hanging denial-audit emit wedges `execute()` forever (liveness, not authz)
**Status:** in-progress
**Priority:** LOW (fails closed; not a bypass. Filed because the wedge-able path is the attacker-reachable one.)
**Depends on:** 10

> **PROGRESS (2026-07-18):** the core mechanism is MERGED (`@bolusi/core` `RuntimeTimerPort`-bounded denial-audit emit + falsified: bypass the bound → the bounded test fails cleanly in ~79ms, terminates not hangs). But it is **INERT in production** — `apps/mobile/src/bootstrap/runtime.ts` does not yet pass `denialAuditTimer`, so the shipping app is still wedgeable. **Task 40 stays in-progress; it completes when [[102-wire-denial-audit-timer-in-production]] wires + falsifies the production opt-in.** Do not mark 40 done on the library merge alone (rev-40's explicit finding).

## Goal

Put a timeout on the denial-audit emit so a never-settling op-append cannot wedge `execute()`.

**The chain, established by reading (review-02, task 10 review) — no timeout, no `Promise.race`, no abort anywhere on it:**

```
#requirePermission          await this.#denialEmitter.record(...)      execute.ts:449
  → DenialEmitter.record()  await this.port.emit(payload, context)     denials.ts ~158
  → emit()                  await this.#emitSanctioned(...)            denials.ts ~213
  → appendLocalOps({...})   against the op-append store
```

If the store's transaction never settles, **`execute()` never settles.**

## What this is NOT — read before sizing it

- **Not an authz bypass.** A wedged denial path means the command **never runs**. Nothing is authorized, nothing is appended. It fails closed in effect.
- **Not a hostile-emitter surface.** The emitter is **deliberately not injectable**: `CommandRuntimeOptions` has no `denialEmitter` field; `#denialEmitter = new DenialEmitter(...)` is constructed internally (`execute.ts:210`) with the reason stated in-code — *"Injecting a pre-built emitter would let a caller supply one whose port silently drops the op, turning the denial audit trail (02 §7, FR-1045) off from the outside."* That is a good call and it removes the interesting attack.
- **Not the swallowed-denial problem it resembles.** `#requirePermission` swallows an emission failure and throws the denial anyway, and the **ordering defuses it**: the decision is computed *before* the emit (`if (decision.allowed) return;` precedes the try), the emit is wrapped in `try { await … } catch {}`, and `throw new DomainError('PERMISSION_DENIED', …)` sits **outside** that catch. So throw and reject both provably still deny — the deny is unconditional. **The catch wraps the AUDIT, not the DECISION.** (The general instinct — *a `catch` around a security decision is where fail-closed goes to die* — is right; it just doesn't apply here, because of where the catch sits.)

## Why it's worth closing anyway

`auth.permission_denied` is emitted on **every** denial, and a denial is the one thing an attacker can trigger at will. So the wedge-able path is also the **attacker-reachable** path: repeated denials are free to provoke.

Realistic severity on the client (op-sqlite, single connection, WAL): a *permanently* unsettling transaction is not the likely failure — a **slow or locked** one is. That degrades to a hung UI on repeated denials rather than a security event. For a tech-inadept user in a busy shop, "the app froze when I tapped the thing I'm not allowed to tap" is a real support call, not a breach.

## Docs to read

- `packages/core/src/runtime/execute.ts` :448-470 (the catch/throw ordering — do **not** disturb it), :210 (why the emitter isn't injectable), :449 (the unguarded await).
- `packages/core/src/runtime/denials.ts` — `record()` → `port.emit` → `#emitSanctioned` → `appendLocalOps`.
- `02-permissions.md` §7 (the denial op + throttle), FR-1045 (the audit trail requirement).
- `testing-guide.md` T-6 (fake timers — a test that sleeps is a bug), T-11.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `packages/core/src/runtime/denials.ts` (or `execute.ts`'s emit call site). **`@bolusi/core` is contended (CLAUDE.md §4)** — serialize.

## Acceptance

**Observable done-condition:** with an op-append store whose transaction never settles, `execute()` on a denied command still **rejects with `PERMISSION_DENIED`** in bounded time.

- **Reproduce the wedge first** (T-11): make the append hang, call `execute` on a denied command, watch it never settle. **Beware the trap that caught the reviewer twice**: its probes were *inert* — one passed a `denialEmitter` override to a fixture with no such field (silently dropped, so it tested the real emitter and measured nothing); the other's console line never printed, so the wedge was never reached. **Assert your fixture is live before believing your result** (T-14b): prove the hang is actually reached — a probe whose output never appears is a probe that ran nothing. If you cannot reproduce the wedge, stop and report; do not "fix" a hang you never saw.
- **The shape** (reviewer's suggestion, and it preserves current semantics exactly): `Promise.race([emit, timeout])` **inside the existing catch**. The catch already swallows, so a timed-out audit still denies unconditionally. **Do not move the `throw` inside the catch, and do not make the deny conditional on the emit** — that ordering is the thing that makes throw/reject safe today, and breaking it converts a liveness note into an authz hole.
- **Falsify** (§2.11): with the timeout in place, the hanging store → `execute` rejects `PERMISSION_DENIED` within the budget; remove the timeout → it wedges again; restore. And prove the **non-regression**: a *working* emitter still records the denial op (the timeout must not silently disable the audit trail on the happy path — that would trade a hang for a missing audit record, which is worse).
- **Use fake timers** (T-6) — a test that sleeps is a bug.
- **Sweep the class** (T-12): is the denial emit the only unguarded `await` on an attacker-triggerable path? Check the other sanctioned runtime emissions and the append path generally. The bug is not "this await"; it is *"an internally-constructed I/O call on a path an attacker can provoke, with no bound."* Report what you find even if you fix only this one.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Found by review-02 while driving a question I asked about a *different* failure mode (hostile emitter). The answer to the asked question was "not reachable — the emitter isn't injectable", and the honest follow-through is what surfaced the real one. Worth preserving: the reviewer reported **two inert probes as inert** rather than counting the green they printed, and marked this LOW rather than inflating a hang into a breach. Both halves matter — the finding is real *and* correctly sized, which is what makes it actionable instead of noise.
