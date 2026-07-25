# TASK 181 — the on-device CHAOS-01/03/06/07 runners need a device-native scenario rig: the existing scenarios live in `@bolusi/harness` (PGlite server + better-sqlite3 `VirtualDevice`), which `apps/mobile` may not import, and CHAOS-03/06/07 need a SERVER round-trip a single emulator does not have

**Status:** todo
**Priority:** MEDIUM — it is what remains between task 178 and a fully-GREEN 27a. Three of the seven emulator gates (SEC-DEV-06-at-rest, SEC-AUTH-09-leg1, SEC-OPLOG-06-jcs) are REAL after 178; the four chaos gates stay HONESTLY `skipped` (never faked — §2.11) until this rig exists. testing-guide §2.6 requires "CHAOS-01/03/06/07 at reduced volume" on the L6 device run for the exit line.
**Depends on:** 178 (which wired the real at-rest + JCS runners and left the chaos ids skipped with the precise reason below), 177, 27a
**Blocks:** 27a going FULLY green (its 4 chaos gates), 28 roll-up indirectly.
**SEC ids owned by THIS task:** none directly (the correctness properties are the chaos scenarios' own).
**Filed by:** impl-178, 2026-07-25, from wiring the on-device gate runners — the at-rest + JCS legs went real; the chaos legs could not, for the structural reason below (not a shortcut, a boundary).

---

## Ground truth (why task 178 left these four skipped, verbatim from `run.ts`)

The four chaos ids (`CHAOS-01`, `CHAOS-03`, `CHAOS-06`, `CHAOS-07`) have **no on-device runner** and task 178 emits an HONEST `skipped` for each, naming this task. Two independent structural blockers, both provable from the checkout:

1. **The scenarios live in `@bolusi/harness`, which `apps/mobile` may not depend on at runtime.** `scenarios/chaos-0{1,6,7}.test.ts` import `../src/convergence.ts` (`runConvergence`/`assertConvergence`), `../src/device.ts` (`VirtualDevice` — better-sqlite3), `../src/server.ts` (`HarnessServer` — `@electric-sql/pglite` + `@bolusi/server`), `HttpTransport`, the oracle, etc. `@bolusi/harness` is a test-tooling package that ships PGlite (a WASM/Node in-process Postgres) and better-sqlite3 (a Node addon) — neither loads on Hermes/in an APK — and `shipping-deps.test.ts` asserts **"@bolusi/harness is never a runtime dependency of shipping code."** apps/mobile IS the device bundle. So the scenarios as written cannot be imported into the on-device harness.

2. **CHAOS-03/06/07 need a real SERVER round-trip a single emulator does not have.** CHAOS-03 is a 4-device days-offline merge THROUGH the server (push-verify + pull-reverify — the ~591 s cost is ~90% server round-trips). CHAOS-06 asserts the server returns `duplicate` on a replay (server-side dedup by op id). CHAOS-07 drives the REAL server conflict-detection pipeline (task 17). The emulator lane runs ONLY the client bundle — there is no server on the device — so these three cannot be exercised on a single emulator at all, reduced volume or not. CHAOS-01 (out-of-order projection convergence) IS client-side, but its `runConvergence` still lives behind the `@bolusi/harness` wall of blocker 1.

## Deliverable

A **device-native scenario rig** that runs reduced-scale chaos on op-sqlite + Hermes using ONLY device-safe packages (`@bolusi/core` projection/ingest/conflict engines are platform-free and reachable; `@bolusi/test-support/device` for the seed/PRNG), with NO `@bolusi/harness`, NO PGlite, NO better-sqlite3 in the bundle. Wire each real runner into `resolveGateResults` at the same seam task 178 used (`apps/mobile/src/harness/run-and-emit.ts` → the runner map). Land in this order, each falsified before believed (§2.11 — a runner that cannot go red is worse than the honest skip it replaces):

1. **CHAOS-01 first (client-only).** Reconstruct out-of-order convergence device-natively: N virtual devices author offline through the real command path over op-sqlite, cross-feed in PRNG-shuffled order, fold through the REAL engine, assert all digests == the canonical-fold reference AND both §4.2 dispatch paths were hit (head-apply AND re-fold). Falsify: a dropped op DIVERGES (red); a run whose re-fold counter is 0 fails INCONCLUSIVE.
2. **Decide CHAOS-03/06/07.** Either (a) stand up a device-embeddable server-equivalent (a large lift — the server is Node/hono/PGlite), or (b) get an owner ruling that these three stay on the Node/emulator-server lane and are NOT part of the single-emulator L6 set, and amend testing-guide §2.6 accordingly (a spec change — stop-and-ask, CLAUDE.md §6). Do NOT fake a server round-trip on device.

## Acceptance

- The chaos gates the rig makes real reach `passed`/`failed` through a runner **watched go RED** (the drop-op divergence for CHAOS-01; the analogue for each other leg landed). Any leg that genuinely cannot run on a single emulator stays HONESTLY `skipped` with a precise reason OR is removed from the L6 required set by owner ruling + a testing-guide amendment — never faked.
- `@bolusi/test-support/device` stays `node:crypto`-free and the release APK still bundles (the 177/178 guards: `device-bundle-safe.test.ts`, `expo export --platform android` EXIT=0). No `@bolusi/harness`/PGlite/better-sqlite3 edge reaches the device bundle.
- Node lanes stay green.

## Note for the picker

Task 178's `apps/mobile/src/harness/run-and-emit.ts` is the seam: `buildDeviceRunners(harness)` returns the runner map, and `run.ts`'s `resolveGateResults` runs an injected runner or skips honestly. Add the chaos runners to that map; the chaos ids' current skip reasons in `run.ts` (`CHAOS_GATE_IDS` → `skipDetailFor`) point here. The at-rest env (`part-c/at-rest-device-env.ts`) is the pattern for binding op-sqlite + the real writers device-safely without `@bolusi/harness`.
