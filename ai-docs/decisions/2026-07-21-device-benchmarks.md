# Decision — 2026-07-21 — Device benchmarks: 27a emulator CORRECTNESS lane built; 27b perf stays deferred

> Trigger: D20 §1 provisioned an Android emulator in CI and made task **27a** buildable. This records
> what the emulator lane discharges (correctness), what it explicitly cannot (performance), and the
> honest status of every figure — because an emulator green that gets read as a device number is the
> exact §2.11 landmine D12/D13 exist to defuse.

## What 27a built (the emulator CORRECTNESS lane)

An emulator runs the shipping release/`test`-profile APK — its OWN Hermes 0.17 and REAL SQLCipher —
so it answers *correctness* questions (is a byte ciphertext, does a vector match, do devices
converge). It cannot answer *performance* (its CPU/storage/RAM are the host's, not a 2 GB device's).
So 27a wired the correctness subset and left the perf half to 27b:

- **SEED-200K generator** (`packages/test-support/src/seed/seed-200k.ts`) — the year-equivalent local
  history (200,000 ops, exactly 20,000 entities × 10 ops, 5,000 MediaItem rows, v1→v2 cutover at op
  100,000) the on-device rebuild / execute-latency runners replay. Deterministic from seed 42.
- **SEC-DEV-06 L6 at-rest leg with its T-14b POSITIVE CONTROL** (`driver-conformance/at-rest.ts` →
  `checkControlSeedIsWitnessed`; device ctx `apps/mobile/src/harness/part-c/at-rest-device-ctx.ts`).
  The device ctx seeds markers into an UNENCRYPTED control DB and asserts they ARE byte-present there
  BEFORE trusting their absence from the SQLCipher file — without it, "no plaintext found" passes
  vacuously. This is the ONLY place real SQLCipher ever runs.
- **SEC-AUTH-09 leg 1** (verifier/salt bytes confined to the SQLCipher DB) — the emulator lane is its
  home; see the coordination note below.
- **SEC-OPLOG-06 JCS vectors on the emulator's Hermes 0.17** (D13) — correctness, closing the version
  skew stage 6 leaves open (CI's host VM is 0.13.0).
- **CHAOS-01/03/06/07 at reduced volume** — convergence correctness, reusing task 26's scenarios
  UNCHANGED.
- **The CI lane** (`.github/workflows/ci.yml` → `android-emulator`, scheduled/dispatch) runs
  `pnpm harness:device`, which captures the `BOLUSI_HARNESS_RESULT` JSON and gates on it (any red /
  missing gate / non-release build / stale capture ⇒ non-zero). Every figure is labelled EMULATOR.
- **Node-side per-PR tests** (swept by the `unit` job): SEED-200K determinism/composition, the
  harness:device parser, the flag-gating (runtime + eas.json placement), and the Part C
  budget-constants mirror.

## Measured status (CLAUDE.md §2.1 — no figure is claimed from an unrun lane)

- **Verified on the dev host (Node/vitest, green):** SEED-200K determinism + composition; the at-rest
  positive control (falsified: neutered ⇒ a no-op/empty control passes vacuously); the harness:device
  parser (falsified: any red/missing gate/non-release/stale runId ⇒ non-zero); the flag-gating
  (falsified: `harnessEnabled` forced true ⇒ the harness is reachable in production).
- **NOT run here — runs in CI's `android-emulator` lane:** the emulator gates themselves (real
  SQLCipher at-rest, JCS on Hermes 0.17, reduced chaos). They typecheck and build; there is no
  emulator on this Linux host (D12/D13). No correctness RESULT is recorded yet — this entry records
  the LANE, not a measurement. When the scheduled lane is observed green, its captured
  `BOLUSI_HARNESS_RESULT` lands under `reports/device-gates/` and this entry is updated with it.

## What stays 27b-DEFERRED (physical device, owner not provided)

D12's asymmetry stands: an emulator cannot produce a device perf number. So the following remain
BLOCKED on the physical 2 GB reference device (task 27b), and NONE is faked on an emulator:

- **Part C performance gates P-1..P-5** (cold start, projection rebuild time/memory, 1-week backlog
  time, argon2id verify p95, command latency) — pinned as code constants
  (`apps/mobile/src/harness/part-c/budgets.ts`, mirroring testing-guide §4.2 verbatim) but measured on
  device only.
- **SEC-AUTH-10** — the argon2id KDF timing benchmark. Owned by 27b; its `sec-pending-allowlist.json`
  row (→ task 27) stays.
- **The op-sqlite write-throughput figure** vs the P-2 667 ops/s floor.
- **D8** (argon2id params: default `m=32768/t=3/p=1` kept vs floor `m=19456/t=2/p=1`) and **D6**
  (op-sqlite throughput rationale) stay UNDECIDED — the first real device may force a change.

## SEC-AUTH-09 leg 1 — coordination with task 28

Leg 1 ("verifiers exist only inside the SQLCipher DB — scan app storage for salt/verifier bytes")
needs real SQLCipher, which only 27a's emulator lane has. The lane is built and will discharge it,
but the emulator run is NOT observed green here, so — per security-guide §2.1.6 (a title claims the
WHOLE id) — **no test titles SEC-AUTH-09**. Its `sec-pending-allowlist.json` row (owned by task 28)
stays until the scheduled `android-emulator` run reports the leg green and task 28 removes it. This
entry is the note that points task 28's inventory here.
