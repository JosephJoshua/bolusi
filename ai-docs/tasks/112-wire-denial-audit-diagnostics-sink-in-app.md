# TASK 112 — wire the denial-audit diagnostics sink in `apps/*` so task 99's surfacing is ACTIVE (it is built + falsified but INERT)

**Status:** todo
**Priority:** **LOW-MEDIUM** — task 99 built, falsified, and merged the surfacing (`DenialAuditDiagnosticsPort.auditAppendFailed`, wired as optional `CommandRuntimeOptions.denialAuditDiagnostics`), but **nothing in `apps/*` binds it**, so a lost FR-1045 denial-audit append is still unobserved in the shipping app. Exactly the shape of task 40 → [[102-wire-denial-audit-timer-in-production]] (mechanism merged, activation a separate one-line app change).
**Depends on:** 99
**Blocks:** — (activates task 99)
**SEC ids owned by THIS task:** none

## The finding (task 99, self-reported)

`denialAuditDiagnostics` is optional; absent = pre-task-99 behaviour byte-for-byte. `apps/mobile/src/bootstrap/runtime.ts` builds the runtime (and already passes `denialAuditTimer` since task 102) but passes no diagnostics sink. Task 99 deliberately did not touch `apps/*`.

**Related, and worth resolving together (T-15):** `packages/i18n/src/logger.ts`'s `I18nLogger` comment says "the app wires the real client diagnostics log at init" — and **no app does**. So the "client diagnostics log" that BOTH surfaces name does not exist as a concrete implementation. Do not cite either as shipped observability until it does.

## Acceptance

- Decide the concrete client diagnostics sink for v0 (the smallest honest thing — a structured console/dev log, or whatever the app already has) and bind it at the `CommandRuntime` construction site in `apps/mobile/src/bootstrap/runtime.ts`, alongside `denialAuditTimer`. Bind `I18nLogger` to the same sink if that's the intended one shape (§2.8 — one diagnostics channel, not two).
- **Falsify against the REAL app composition (task 102's lesson — a mechanism wired in a test but not in the app is inert):** compose the runtime the way `runtime.ts` does, force an audit-append failure, and assert the app's sink RECEIVES the record (and the deny still throws). Remove the binding → the record is unobserved → RED → restore → green.
- Correct the `I18nLogger` comment if the "client diagnostics log" still doesn't exist after this task (T-15 — no aspirational comments stated as fact).
- `pnpm typecheck`/`pnpm lint`/`pnpm --filter @bolusi/mobile test` green — read the output (§2.1).

## Note
Filed from task 99. Third instance of the same pattern this cycle (40→102, 20→105, now 99→112): core ships an injectable seam, the app never binds it, and the guarantee is inert until someone wires it. Worth a standing check when any task adds an optional port — "who binds this in production?" belongs in the task's own acceptance.
