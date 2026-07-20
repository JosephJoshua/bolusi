# TASK 99 — a persistently-failing denial-audit append is SILENT (the shared task-10 `catch {}` swallows it on every denial path)

**Status:** done
**Priority:** **LOW** — a cross-cutting FR-1045 reliability gap, accepted at v0 by design (deny must survive a failed audit — task 10), but worth closing before scale. No live incident; the risk is a broken audit trail that nobody notices.
**Depends on:** 10
**Blocks:** —
**SEC ids owned by THIS task:** none (hardens FR-1045 audit-trail reliability; no new id)

## The finding (task 44 review, rev-44 check 4)

Every denial-audit emission is wrapped so the **deny survives a failed audit append** (correct — a denial must never be blocked by an audit-write failure; task 44's "deny survives a FAILED audit append" test proves it by injecting disk-full and asserting still-denied, op-absent). But the `catch {}` is **silent**: no log, no metric, no surface. So a **persistently** failing audit append (disk full, corrupt DB, migration drift) makes the denial audit trail silently incomplete on BOTH the evaluator path (`requirePermission`, task 10) and the restriction path (`denyRestriction`, task 44) — they share the exact swallow shape.

rev-44's exact words: "a persistently-failing audit append is invisible on BOTH the evaluator and restriction paths equally — a shared FR-1045 completeness gap in the task-10 pattern, not introduced by task 44 ... Flag as a future cross-cutting item if you want 'surface persistent audit-write failure'."

## Why it is LOW, not ignorable

FR-1045 is a completeness guarantee. A guarantee whose failure mode is **silent** is exactly the §2.11 class ("a guard that silently checks nothing"): the audit trail can be lied to by a disk fault and no operator would know. It is LOW only because (a) deny still works (fail-safe on the security decision), and (b) it requires a persistent I/O fault to trigger. But when it triggers, the audit trail — the thing an owner reaches for AFTER an incident — is quietly wrong.

## Acceptance

- **One surface point (§2.8):** the swallow lives in the shared enforcement path (task 10's `requirePermission` catch + task 44's `denyRestriction` catch — confirm they are the same emitter/catch or unify them). Add a single **surfaced** signal on audit-append failure — the smallest thing that an operator/monitor can see: a structured error log / a counter / a `device_anomalies`-style row (reuse an existing surface; do not invent a channel). The deny still succeeds unconditionally — do NOT change that.
- **Falsify (§2.11):** inject a persistent audit-append failure → the surfaced signal fires (asserted) AND the deny still returns the DomainError (both). Break the surfacing → the signal is absent under fault → test RED; restore → green. This proves the new signal is load-bearing, not decorative.
- Do NOT weaken the fail-safe: a transient audit failure must not block a deny, and the surfacing must not throw into the deny path.
- `pnpm typecheck`/`pnpm lint`/`pnpm test` green — read the output (§2.1).

## Note
Filed from task 44's review. Both task 10 (evaluator denials) and task 44 (restriction denials) deliberately mirror the same swallow — which is correct for the DECISION (deny is unconditional) but leaves the AUDIT silently lossy. This task adds the missing observability without touching the fail-safe. Pairs with [[98-server-arm-denial-audit-gap]] (the other half of "is the FR-1045 trail actually complete").
