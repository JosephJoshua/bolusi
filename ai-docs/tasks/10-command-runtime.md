# TASK 10 — command-runtime (execute sequence, ctx, DomainError registry, runtime emissions)
**Status:** in-review
**Depends on:** 06, 08, 09

## Goal
Deliver the command layer of `@bolusi/core`: `execute(command, rawInput, ctx)` implementing the seven-step sequence of 04 §5.1 — strict Zod parse, `ctx.requirePermission()` (fail closed, via the task-09 evaluator), pure handler invocation, envelope completion with EVERY 05 §2.1 field (single runtime `timestamp` stamp per command; `location` from `LocationPort.getBestFix()`, null never blocks), atomic append (task-06 path) + projection apply (task-08 engine) in one transaction, then a debounced sync-schedule hook. Ships the `ctx` object (`tenantId/storeId/userId/deviceId`, `op()`, `newId()` UUIDv7 via injected IdSource, `requirePermission()`, `query()` as a typed seam over an injected query executor — the real query runtime lands in task 11), the closed `DomainError` code registry (04 §5.3, exported as an enumerable constant), and the runtime-emission channel restricted to the five sanctioned op types (04 §5.1 / 02 §4). Handlers get no clock: `ClockPort` is injected at runtime construction (08 §3.2), enforced by lint + a runtime purity guard. No sync loop, no defineModule, no server work — those are tasks 15 and 11.

## Docs to read
- `04-module-contract.md` §5 (5.1 sequence, 5.2 purity rules + ctx surface, 5.3 DomainError registry) — the contract this task implements.
- `02-permissions.md` §4 (single enforcement point; the five runtime-emitted exceptions; denial = explicit error, never empty result).
- `05-operation-log.md` §2 (envelope fields the runtime must complete; explicit-null rule §3 as it applies to nullable core fields).
- `08-stack-and-repo.md` §3.2 (`@bolusi/core` row: ClockPort / LocationPort / port contracts; platform-free constraint) and §5.2 (custom-lint-rule conventions the new rules must follow).
- `testing-guide.md` §1 T-6/T-7 and §3.3 (injected Clock/IdSource, FakeClock/determinism kit — the runtime must be constructible from it).
- `07-i18n.md` §7.3 (error-code coverage CI gate this task hooks the registry into).

## Skills
- `superpowers:test-driven-development` (always).
- `superpowers:verification-before-completion` — run the suites and lint yourself before claiming done.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched
- `packages/core/src/runtime/` — `execute.ts`, `ctx.ts`, `domain-error.ts` (registry + class), `runtime-emissions.ts` (allowlist channel), sync-schedule hook seam. **CONTENDED `@bolusi/core`** — serializes with tasks 02/06/08/11 per `_index.md`; confirm none is in flight before starting.
- `packages/core/test/runtime/*.test.ts` (unit + L2-style integration on better-sqlite3 `:memory:` per testing-guide §2).
- `tooling/eslint/` (`eslint-plugin-bolusi`): two new rules — `bolusi/no-clock-in-handlers` (no `Date.now`/`new Date()`/`Math.random`/`fetch`/timer globals in module command-handler files) and `bolusi/runtime-emission-allowlist` (non-command appends only for the five sanctioned types). NOTE: adding these rows to the 08 §5.2 rule table is a spec edit — flag it as its own task (CLAUDE.md §4), do not edit `ai-docs/` from the worktree.
- CI workflow: error-code coverage gate (07-i18n §7.3) wired to the exported registry (checks `@bolusi/i18n` catalog when the package exists; until task 22 lands, checks the `ai-docs/ui-labels.md` `core.errors.*` seed table so the gate is live from this task on).

## Acceptance
- **Observable:** `pnpm --filter @bolusi/core test` green including a full-sequence integration test (fixture command → parse → permission → handler → append → project → query-visible row) on better-sqlite3 `:memory:`; repo lint green with both new rules active at `error`.
- **Sequence & envelope tests (concrete):**
  - Input with an unknown key or wrong type → `DomainError('VALIDATION_FAILED')`; handler never invoked; nothing appended, projections untouched.
  - Every 05 §2.1 field present on appended ops; nullable fields explicitly `null` (never absent); `source: "ui"` / `agentInitiated: false` / `agentConversationId: null` defaults applied.
  - One command emitting 2+ op drafts → all drafts share one runtime-stamped `timestamp` (04 §5.2 atomic stamp).
  - `LocationPort.getBestFix()` returning a fix → stamped verbatim; returning `null` → op appends with `location: null` and the command completes without waiting (assert no retry/poll of the port).
  - `ctx.newId()` yields valid UUIDv7 from the injected IdSource; whole runtime constructible with FakeClock + seeded IdSource, producing byte-stable ops per seed (testing-guide T-6 — the seam every CHAOS scenario's simulator needs).
  - `ctx.query()` routes to the injected query executor with the ctx identity; handler reads via anything else are unrepresentable (no db handle on ctx).
- **Permission-denied path:** user lacking the command's permission → `DomainError('PERMISSION_DENIED')` thrown, handler never invoked, business op NOT appended, and exactly one `auth.permission_denied` op appended through the runtime-emission channel (payload/throttle owned by task 09 — assert wiring, not re-test evaluation). Denial is an error, never an empty success.
- **Atomicity:** an applier that throws mid-apply rolls back the whole transaction — op absent from the local log, device `seq`/chain head unchanged, projection rows unchanged; the next command reuses the freed `seq` and succeeds. Same assertion when the append itself fails after the handler ran.
- **Runtime-emission allowlist:** each of the five sanctioned types (`auth.user_switched`, `auth.session_ended`, `auth.permission_denied`, `auth.pin_locked_out`, `auth.device_enrolled`) appends via the channel without a command or permission check; a 6th type → throws, nothing appended. Lint fixture: source performing a non-command append of an unsanctioned type fails `bolusi/runtime-emission-allowlist`.
- **Purity harness (adversarial, ships in this task before review — CLAUDE.md §2.5):** lint fixtures for `Date.now()`, `new Date()`, `Math.random()`, `fetch`, `setTimeout` inside a command handler each fail `bolusi/no-clock-in-handlers`; runtime guard test — a test-support wrapper poisons `Date.now`/`Math.random`/`fetch` for the duration of handler invocation, and a deliberately violating fixture handler fails while a clean handler passes.
- **DomainError registry:** exported enumerable equals exactly the twelve 04 §5.3 codes (test pins the set — adding/removing a code fails); unknown code at construction is a compile-time type error and a runtime throw; error carries `code` + `message`, no UI strings.
- **SEC-\*/CHAOS-\* roll-call:** no named SEC/CHAOS id is owned by this surface (security-guide roll-up assigns them to oplog/sync/auth/device/media/tenant/rt tasks). The command-layer denial legs of SEC-AUTH-06 / SEC-AUTH-11 and the CHAOS-11 command surface land with tasks 14/26/28 and consume this task's denial path and Clock seam — the adversarial floor HERE is the purity-guard, denial-path, allowlist, and atomicity tests above.
- **Lint/CI gates:** both new eslint rules registered in the shared flat config at `error`; error-code coverage gate live in CI and failing when any registry code lacks its `core.errors.<CODE>` row; `@bolusi/core` boundary rules still pass (no new runtime deps, platform-free — no `node:*`/RN/expo imports).
