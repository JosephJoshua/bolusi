# TASK 102 — wire `denialAuditTimer` into the production mobile runtime so task 40's liveness bound is ACTIVE (it is currently INERT in production)

**Status:** done
**Priority:** **MEDIUM** — task 40 built + tested + falsified the mechanism (a `RuntimeTimerPort`-bounded denial-audit emit so a hung append cannot wedge `execute()`), but it is **OPTIONAL and not passed in production**: `apps/mobile/src/bootstrap/runtime.ts` (~line 90) calls `createModuleRuntime` WITHOUT `denialAuditTimer`, so the shipping app still runs the pre-task-40 UNBOUNDED await. **Until this lands, the wedge task 40 fixed is still live on the device.** "Typed and compiling is not running on the target" (D17 lesson).
**Depends on:** 40
**Blocks:** — (completes task 40)
**SEC ids owned by THIS task:** none (activates a liveness guarantee; no new id)

## The finding (task 40 implement f-1 + rev-40 flag 2, both confirmed)

Task 40's `#recordBounded` bounds the emit ONLY when a `RuntimeTimerPort` is injected via `CommandRuntimeOptions.denialAuditTimer` (default budget `DENIAL_AUDIT_EMIT_TIMEOUT_MS = 2000`). The port already exists and is structurally satisfied by `apps/mobile/src/ports/timer.ts` `systemTimer` (identical `schedule(delayMs, fn) => cancel` shape, also used for sync's `TimerPort`), and `RuntimeTimerPort` is exported from `@bolusi/core`. But the production composition (`apps/mobile/src/bootstrap/runtime.ts`) never passes it — so `#auditBound === null` → unbounded await → a stuck op-sqlite WAL lock on a denial wedges `execute()` forever on-device. rev-40 verified the call site (runtime.ts:90) passes no timer (grep empty).

The optional design is correct (it keeps out-of-tree/harness callers of `createModuleRuntime` byte-for-byte unaffected — a required field would break them); the gap is purely the missing production opt-in.

## Acceptance

- Pass `denialAuditTimer: systemTimer` (and, if the task's default is not wanted, `denialAuditTimeoutMs`) to `createModuleRuntime` at `apps/mobile/src/bootstrap/runtime.ts`. Confirm `systemTimer` already satisfies `RuntimeTimerPort` (it does — do not add a second timer, §2.8).
- **Falsify against the REAL apps/mobile runtime, NOT the core fixture (rev-40's explicit ask — task 40 already proved the library; this task proves the WIRING):** a test that composes the runtime the way `runtime.ts` does (through `createAppRuntime`/the real composition) with a hung denial-audit emit, and asserts `execute()` on a denied command REJECTS `PERMISSION_DENIED` within the bounded time (not a hang). Then REMOVE the `denialAuditTimer` line → the test wedges/fails (proving the wiring is what activates the bound) → restore → green. Report the falsification.
- Confirm the deny stays unconditional in the production composition (the audit is best-effort; the deny fires regardless).
- `pnpm typecheck`/`pnpm lint`/`pnpm --filter @bolusi/mobile test` green — read the output (§2.1).
- **On merge, THIS is what lets task 40 be marked `done`** — set 40 → done only once production is actually bounded (this task's test proves it).

## Note
Filed from task 40. Task 40 correctly scoped itself to `@bolusi/core` and did not reach into `apps/mobile` (§4). This is the activation half — the same shape as task 43 (server done) → task 97 (client registration), and task 26 (kit) → the harness. A mechanism that compiles but isn't wired on the target protects nothing; task 40 stays in-progress until this lands.
