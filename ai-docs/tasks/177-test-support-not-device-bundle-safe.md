# TASK 177 — `@bolusi/test-support` cannot be bundled into the release APK: its barrel re-exports `node:crypto`, so the on-device harness (task 175) can name the gates but cannot RUN them

**Status:** todo
**Priority:** **HIGH — the last thing between the emulator lane and a GREEN 27a.** Task 175 landed the producer plumbing (flag → HarnessActivity → JS harness → native tagged emit) and the lane now emits an honest partial with all 7 gates `skipped`. Wiring the real gate BODIES (`loadHarness()` → SEED-200K rebuild + the SEC-DEV-06 at-rest probe + the JCS/chaos legs) is blocked HERE.
**Depends on:** 175 (which discovered this by building the producer and running `expo export`)
**Blocks:** 27a (its emulator gates stay `skipped` until this lands), 27b indirectly (same package)
**SEC ids owned by THIS task:** none.
**Filed by:** impl-175, 2026-07-25, from the FIRST-EVER Metro bundle of a harness-reachable `apps/mobile/index.ts`.

---

## Ground truth (provable on the Linux dev host — no device needed)

`npx expo export --platform android` (EXPO_PUBLIC_BOLUSI_TEST_HARNESS=1) with task 175's producer wiring, verbatim:

```
Android Bundling failed 7267ms apps/mobile/index.ts (1526 modules)
Error: Unable to resolve module node:crypto from
  packages/test-support/dist/crypto/node-column-aead.js: node:crypto could not be found …
Import stack:
  packages/test-support/dist/crypto/node-column-aead.js  ← import "node:crypto"
  packages/test-support/dist/index.js                    ← import "./crypto/node-column-aead.js"
  apps/mobile/src/harness/registry.ts                    ← import "@bolusi/test-support"
  apps/mobile/src/harness/run-and-emit.ts …→ HarnessApp →register →apps/mobile/index.ts
```

This is a REGRESSION-class defect: nothing under `apps/mobile/index.ts` imported `@bolusi/test-support` before, so the release APK assembled (task 148). The moment task 175 makes `loadHarness()` reachable from the production entry, the Gradle `assembleRelease` Metro bundle fails on `node:crypto` — the same failure `expo export` shows. **Node (vitest) and `tsc` never see it** — Node resolves `node:crypto`, Metro cannot. This is the T-11 shape exactly: "typed and compiling is not running on the target."

## Root cause

`packages/test-support/src/index.ts` is a single barrel and the package exposes only one export (`.`). The barrel line 7 `export { nodeColumnAead } from './crypto/node-column-aead.js'` re-exports a **Node** column cipher that `import`s `node:crypto` at module top level. Metro bundles every static dependency of an imported module, so importing ANYTHING from the barrel (the device harness wants only `generateSeed200k`/`SEED_200K`/`mulberry32` and the at-rest probe interfaces) drags `node:crypto` into the device bundle.

`node-column-aead.js` is **Node-test-only** — it is the plaintext-control cipher for the at-rest positive control's UNIT test (explicit injected bytes). The DEVICE at-rest gate uses op-sqlite + the app's real `deviceColumnAead` (quick-crypto/OpenSSL), never this. So the coupling is purely a barrel-shape artifact, not a real device need.

## How task 175 worked around it (so the lane still emits)

The device path (`apps/mobile/src/harness/{gates,run,run-and-emit}.ts`) names the 7 gate ids from a dependency-free `gates.ts` and does NOT import `registry.ts`/`@bolusi/test-support`, so the bundle builds and the lane emits an honest all-`skipped` partial that the driver fails on, naming each gate + "blocked on 177". `registry.ts` (the real `loadHarness()`) stays Node-/test-only. **This task removes that workaround by making test-support device-safe.**

## Deliverable

Give `@bolusi/test-support` a **device-bundle-safe** surface the harness can import without pulling `node:crypto`, then wire the runners:

1. **Split the barrel / add a subpath export.** e.g. `@bolusi/test-support/harness` (or `/device`) re-exporting ONLY the device-safe pieces the on-device harness needs — the SEED-200K generator (`generateSeed200k`/`SEED_200K`/`mulberry32`) and the at-rest probe interfaces (`checkControlSeedIsWitnessed`/`checkDbAtRestIsCiphertext`/`AtRestProbeContext`) — with NO static path to `node:crypto`/`node:*`. Keep the existing `.` barrel for Node importers (server, other packages) unchanged. **Contended package (§4): serialize; verify every existing `@bolusi/test-support` importer still resolves.**
2. **Repoint `apps/mobile/src/harness/registry.ts` + `part-c/at-rest-device-ctx.ts`** at the device-safe subpath, and re-wire the device entry (`run.ts`/`run-and-emit.ts`) to call `loadHarness()` and run the runners it can.
3. **Wire the gate runners** (as many of the 7 as are real): the at-rest gate has `runAtRestGate` + the `AtRestDeviceEnv` seams to build; JCS/chaos need their on-device runners (still 27a proper). Emit `passed`/`failed` where real, keep `skipped` (naming the reason) where not.

## FALSIFY (§2.11 — provable on the Linux host)

- **The bundle builds:** `npx expo export --platform android` (flag on) SUCCEEDS after the repoint — the `node:crypto` resolution error is gone. This is the direct falsification; it is what task 175 could not make pass.
- **No Node importer broke:** `pnpm -r typecheck` + the full test suite green after the barrel split.
- **The wired gates go green on the emulator** is the RUNNER's job (no AVD on the dev host) — label it runner-only.

## Note for the picker

Task 175's `apps/mobile/src/harness/gates.ts` is the seam: the device path reads gate ids from there today. When you repoint registry.ts at the device-safe subpath, `run-and-emit.ts` can call `loadHarness()` again and `resolveGateResults()` can take the runners — the single change site is documented in both files' headers.
