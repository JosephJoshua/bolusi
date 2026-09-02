# TASK 181 — ship the device-native CHAOS-01 convergence runner (client-only); CHAOS-03/06/07 server-round-trip deferred to task 198

**Priority:** MEDIUM — shipped. CHAOS-01 now runs device-native (client-only convergence over op-sqlite, HEAD `3ec8c8f`). The three server-round-trip chaos gates (CHAOS-03/06/07) are deferred to **task 198** (D24 option C's premise was falsified — see the Rescope banner); they stay HONESTLY `skipped` on the device lane (never faked — §2.11) and already PASS on Node against `@bolusi/harness`.
**Depends on:** 178 (which wired the real at-rest + JCS runners and left the chaos ids skipped with the precise reason below), 177, 27a
**Blocks:** 27a's CHAOS-01 gate (delivered). Its CHAOS-03/06/07 gates + the §2.6 L6 exit line now block on **task 198**, not this task.
**SEC ids owned by THIS task:** none directly (the correctness properties are the chaos scenarios' own).
**Filed by:** impl-178, 2026-07-25, from wiring the on-device gate runners — the at-rest + JCS legs went real; the chaos legs could not, for the structural reason below (not a shortcut, a boundary).

---

## Rescope (2026-09-03): D24 option C's premise falsified at the producer → 181 = CHAOS-01 only; 03/06/07 → task 198

D24 (`ai-docs/decisions/2026-09-02-owner-ruling-181-device-server-chaos.md`) ruled option C on the premise **"the device already reaches the host `@bolusi/server` — the P-3 perf gate already hits it over Wi-Fi."** Traced to producers on 2026-09-03, that premise is **false**: the "harness server" is an in-process Hono `app.request` handler with **no socket** (`packages/harness/src/server.ts:187`, header line 3 "no sockets"); **no listener** wraps it (`serve(`/`@hono/node-server` → none); **no device→host mapping** exists (`10.0.2.2`/`adb reverse` → none); synthetic devices are minted **in-process** by `seedDevice` (`server.ts:196` direct `INSERT INTO devices`), not over HTTP; and P-3 itself has **never run** (testing-guide §4.2 D21: "No gate in this table has been run"). The device→host Wi-Fi sync path is spec design intent (§2.6) with no producer — the T-16 "a mention is not a producer" class.

**Owner ruling (2026-09-03): defer to a filed task.** CHAOS-03/06/07 stay honest device-lane skips (they already pass on Node's `HarnessServer` scenario); the host-network harness (socket + token handoff + host-mapping) + the three device runners are filed as **task 198**. CHAOS-01 stays the shipped device-native chaos slice. No fabrication, no unwatched-red infra. Full record: `ai-docs/decisions/2026-09-03-defer-device-host-network-chaos-to-198.md`.

Everything below this banner is the ORIGINAL task text, kept for history; the D24-era claims that "the device CAN reach a host-run server" are the ones this banner corrects — read them as the falsified premise, not current truth.

## Ground truth (why task 178 left these four skipped, verbatim from `run.ts`)

The four chaos ids (`CHAOS-01`, `CHAOS-03`, `CHAOS-06`, `CHAOS-07`) have **no on-device runner** and task 178 emits an HONEST `skipped` for each, naming this task. Two independent structural blockers, both provable from the checkout:

1. **The scenarios live in `@bolusi/harness`, which `apps/mobile` may not depend on at runtime.** `scenarios/chaos-0{1,6,7}.test.ts` import `../src/convergence.ts` (`runConvergence`/`assertConvergence`), `../src/device.ts` (`VirtualDevice` — better-sqlite3), `../src/server.ts` (`HarnessServer` — `@electric-sql/pglite` + `@bolusi/server`), `HttpTransport`, the oracle, etc. `@bolusi/harness` is a test-tooling package that ships PGlite (a WASM/Node in-process Postgres) and better-sqlite3 (a Node addon) — neither loads on Hermes/in an APK — and `shipping-deps.test.ts` asserts **"@bolusi/harness is never a runtime dependency of shipping code."** apps/mobile IS the device bundle. So the scenarios as written cannot be imported into the on-device harness.

2. **CHAOS-03/06/07 need a real SERVER round-trip a single emulator does not have.** CHAOS-03 is a 4-device days-offline merge THROUGH the server (push-verify + pull-reverify — the ~591 s cost is ~90% server round-trips). CHAOS-06 asserts the server returns `duplicate` on a replay (server-side dedup by op id). CHAOS-07 drives the REAL server conflict-detection pipeline (task 17). The emulator lane runs ONLY the client bundle — there is no server on the device — so these three cannot be exercised on a single emulator at all, reduced volume or not. CHAOS-01 (out-of-order projection convergence) IS client-side, but its `runConvergence` still lives behind the `@bolusi/harness` wall of blocker 1.

   **[~~Corrected by D24, 2026-09-02: the device CAN reach a host-run `@bolusi/server` over Wi-Fi — the P-3 perf gate already does~~ — FALSIFIED 2026-09-03 (see Rescope banner). The P-3 path has no producer: no socket, no listener, no host-mapping, no HTTP enrollment, and P-3 never ran. Blocker 2 stands as originally written: CHAOS-03/06/07 need a SERVER round-trip that does not yet exist on any device lane. Building it is task 198.]**

## Deliverable

A **device-native scenario rig** that runs reduced-scale chaos on op-sqlite + Hermes using ONLY device-safe packages (`@bolusi/core` projection/ingest/conflict engines are platform-free and reachable; `@bolusi/test-support/device` for the seed/PRNG), with NO `@bolusi/harness`, NO PGlite, NO better-sqlite3 in the bundle. Wire each real runner into `resolveGateResults` at the same seam task 178 used (`apps/mobile/src/harness/run-and-emit.ts` → the runner map). Land in this order, each falsified before believed (§2.11 — a runner that cannot go red is worse than the honest skip it replaces):

1. **CHAOS-01 (client-only) — DONE, HEAD `3ec8c8f`.** Reconstructed out-of-order convergence device-natively: N virtual devices author offline through the real command path over op-sqlite, cross-feed in PRNG-shuffled order, fold through the REAL engine, assert all digests == the canonical-fold reference AND both §4.2 dispatch paths were hit (head-apply AND re-fold). Falsified: a dropped op DIVERGES (red); a run whose re-fold counter is 0 fails INCONCLUSIVE (`chaos-01-device-env.test.ts`). Wired in `run-and-emit.ts` `buildDeviceRunners`.
2. **CHAOS-03/06/07 — DEFERRED to task 198 (D24 option C's premise falsified 2026-09-03, see Rescope banner).** They need a device→host `@bolusi/server` round-trip that does **not exist** on any device lane: the harness server has no socket, no listener, no host-mapping, and no HTTP device-enrollment (the four producer traces in the banner). Building that host-network harness + the three runners on top is **task 198**. Until then they stay HONEST device-lane skips (they already PASS on Node against `@bolusi/harness`'s in-process `HarnessServer` — the correctness property is proven; only the device-native execution is deferred). The testing-guide §2.6 amendment D24 authorized is deferred WITH the runners (§2.11 — no over-claim ahead of a producer) and lands in task 198's commit.

## Acceptance (as delivered — CHAOS-01 only; 03/06/07 → task 198)

- **CHAOS-01** reaches `passed`/`failed` through a runner **watched go RED** — the drop-op divergence + the refolds=0 INCONCLUSIVE control, both driven THROUGH `runChaos01Gate` (`chaos-01-device-env.test.ts`, Node leg). ✓
- **CHAOS-03/06/07** stay HONESTLY `skipped` on the device lane with a precise producer-traced reason (`run.ts` `skipDetailFor` → task 198); they already PASS on Node against `@bolusi/harness`. Not faked, not de-scoped off L6 — deferred to the filed task 198 that builds the missing host-network transport.
- `@bolusi/test-support/device` stays `node:crypto`-free and the release APK still bundles (the 177/178 guards: `device-bundle-safe.test.ts`, `expo export --platform android` EXIT=0). No `@bolusi/harness`/PGlite/better-sqlite3 edge reaches the device bundle. ✓
- Node lanes stay green. ✓

## Note for the picker

Task 178's `apps/mobile/src/harness/run-and-emit.ts` is the seam: `buildDeviceRunners(harness)` returns the runner map, and `run.ts`'s `resolveGateResults` runs an injected runner or skips honestly. CHAOS-01 is now in that map; CHAOS-03/06/07 are still skipped and their reasons in `run.ts` (`CHAOS_GATE_IDS` → `skipDetailFor`) now point at **task 198**. The CHAOS-01 device rig (`part-c/chaos-01-device-env.ts`) is the pattern for a device-native runner bound through an injected seam; the at-rest env (`part-c/at-rest-device-env.ts`) is the pattern for binding op-sqlite device-safely without `@bolusi/harness`.
