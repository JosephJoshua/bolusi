# TASK 209 — dedup the lane/chaos server-entry `.mjs` process scaffold, and drop the dead loopback re-check in `harness-serve-lane.mjs`

**Depends on:** 201 (landed `scripts/harness-serve-lane.mjs`, the second copy of the scaffold)
**Blocks:** — (maintainability / simplification; no behavior change)
**SEC ids owned by THIS task:** none — but `scripts/harness-serve-lane.mjs` is a §2.5 token-minting-server entry; the loopback-bind assertion is THE control. Both legs below touch that entry, so falsify the bind guard fires from its single site before deleting the second one.
**Priority:** LOW — no failing input; two independent simplifications surfaced by review-wave-201, folded because both touch `harness-serve-lane.mjs` and a scaffold-extraction rewrite of that file is the natural moment to drop the dead re-check (cf. task 200 folding four dedup families).
**Filed by:** review-wave of task 201 (2026-09-08). Both legs **CONFIRMED real** (V4/R2 duplication lens; V9/R4 simplicity lens), each refuted only as a *task-201 merge blocker*. Per the review-wave skill confirmed findings are filed, not lost.

## Docs to read

- CLAUDE.md §2.8 (one implementation / rule-of-three), §2.11 (a guard is load-bearing only once watched go red), §4 (contended shared)
- `security-guide.md` (the lane loopback-bind control, if the re-check leg is touched)

## Leg A (V4/R2) — extract the shared long-lived-server `.mjs` process scaffold

`scripts/harness-serve-lane.mjs` reproduces, near-verbatim, the entry scaffold of `scripts/harness-chaos-server.mjs`:

| Shared block | serve-lane.mjs | chaos-server.mjs |
| --- | --- | --- |
| `RESOLUTION (why imports are relative dist/…)` comment | `15-19` | `27-34` |
| `import { register } from 'tsx/esm/api'` + the tsx/migrator `ERR_MODULE_NOT_FOUND` rationale + `register()` | `20-36` | `35-68` |
| shutdown lifecycle — `closing` flag + `process.once('SIGTERM'/'SIGINT', shutdown)` + `try { await …close() } finally { process.exit(0) }` | `56-68` | `124-136` |
| `main().catch` — stderr `error.stack ?? error.message` then `process.exit(1)` | `96-102` | `166-173` |

`serve-lane.mjs:4` admits it: "(the exact shape `harness-chaos-server.mjs` uses for CHAOS)". >30 lines of shared entry scaffold; a fix to the SIGTERM/exit-code handling (a §2.11-sensitive false-green surface) must currently be applied in two places.

**Fix:** hoist the shared scaffold into one sibling helper (e.g. `scripts/harness-server-entry.mjs`) both entries import — the `tsx` `register()` + its rationale comment, the resolution/import-strategy comment, the shutdown handler (parameterised over "close these servers": one `running` for serve-lane, the `servers[]` array for chaos), and the `main().catch(prefix)` (parameterised on the `harness-serve-lane:` / `harness-chaos-server:` prefix). Each entry keeps only its own boot/provision body. The two root `.mjs` entries already share code (`chaos-server` imports `formatChaosNetHandshake` from `harness-device.mjs`), so a shared home is feasible.

## Leg B (V9/R4) — drop the dead `assertLaneLoopbackBind(running.address)` re-check

`harness-serve-lane.mjs:75-80` re-asserts the loopback bind AFTER `startHarnessServer(...)` returns:
```
try { assertLaneLoopbackBind(running.address); }
catch (error) { await running.close(); throw error; }
```
This branch is **unreachable**: `startHarnessServer({ productionAuth: true })` → `listen()` runs `assertLaneLoopbackBind(hostname)` (server.ts, ~`377-378`) with `hostname` defaulting to `127.0.0.1` and throws **before returning**, so by the time `running` exists its address is always `127.0.0.1` and the catch (close + rethrow) can never run. The invariant is asserted a third time by the driver (`harness-lane-e2e.mjs`, ~`80`).

**Fix:** drop the redundant re-assert + try/catch (serve-lane.mjs:75-80) and rely on `listen()`'s single bind-site guard; keep at most the driver's cross-process marker check if a boundary re-parse is truly wanted. Update the serve-lane.mjs:72-74 comment (it currently narrates the now-removed re-check as the control) to point at the `listen()` bind-site guard as THE control.

## FALSIFY (§2.11)

- **Leg A duplication gone:** after extraction the shutdown lifecycle + `main().catch` + `register()` block appear **once** (the shared helper) + two importers. Re-inline one copy and confirm a lint/dup/knip guard reds (or the shared helper's export goes unused), then revert. Both entries still boot: run the lane e2e path and the chaos-net child-boot scenario (`packages/harness/scenarios/chaos-net-server-child.test.ts`) green.
- **Leg B — do NOT delete a security guard blind (§2.1/§2.5).** Before removing the re-check, PROVE the upstream `listen()` assertion actually fires: temporarily make `startHarnessServer` request a non-loopback hostname (or stub `assertLaneLoopbackBind` at the bind site to a no-op) and confirm the server **fails to boot** / the bind assertion reds — i.e. watch the single remaining guard go red — then restore. Only then is the second (unreachable) check safe to delete. Confirm the lane still binds loopback-only after the change.

## Acceptance

- The `.mjs` server-entry scaffold (tsx `register()` + rationale, shutdown lifecycle, `main().catch`) lives in **one** shared home; `harness-serve-lane.mjs` and `harness-chaos-server.mjs` each carry only their own boot/provision body.
- `harness-serve-lane.mjs` no longer contains the unreachable `assertLaneLoopbackBind(running.address)` re-check; the loopback control is documented as the `listen()` bind-site guard, and the lane still binds loopback-only.
- The lane e2e path and the chaos-net child-boot scenario are green before and after.
- `pnpm typecheck` / `lint` / `knip` (+0 new) green. Root `.mjs` scripts are NOT an `apps/mobile` dependency; `@bolusi/harness` stays `"private": true`.

## Note

`scripts/` root `.mjs` entries are un-unit-testable directly — the guard against their regression is the emulator lane + the child-boot scenarios, so verify against those, not a new unit. Do NOT touch `ci.yml` (contended, task 194); wire nothing new — this is pure code dedup + dead-code removal.
