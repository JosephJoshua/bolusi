# Decision — 2026-07-15 — D12: no physical device; v0 cannot fully exit D4

> Trigger: the owner confirmed no physical 2GB-class Android is available. D4 (`decisions/2026-07-14-v0-foundation.md`) makes "the reference module running on a physical 2GB Android" half of the v0 exit criterion. That half is now unmeetable. Recording it rather than letting an emulator launder a guess into a number.

## D12 — Task 27 splits: emulator lane runs now, device lane blocks; three claims stay explicitly unproven

**What:**
1. **Task 27 splits in two.** `27a` (emulator lane) runs everything an emulator can honestly prove and lands in v0. `27b` (device lane) is **blocked**, not deleted, and holds every gate whose number is hardware-bound.
2. **v0 exits on 26 + 28 + 27a**, with the D4 device clause explicitly **deferred, not satisfied**. Anyone reading "v0 done" must be able to see what that excludes — see the unproven list below.
3. **The emulator lane never reports a number as if it were a device number.** Its report records the host CPU/emulator image and labels every figure `EMULATOR — NOT A DEVICE MEASUREMENT`. A gate that cannot be honestly measured is reported as `UNPROVEN`, never as pass. (testing-guide T-11/T-14: a green that means nothing is worse than a red.)

**Why an emulator cannot stand in.** An Android emulator runs on this host's x86 cores with host RAM. It shares an ISA and a clock speed with nothing in West Papua. For anything CPU-, storage-, or memory-bound, its numbers are not conservative estimates — they are unrelated numbers.

## The three claims that stay unproven until 27b

| Claim | Owner | Why an emulator cannot settle it | Consequence of leaving it open |
| ----- | ----- | -------------------------------- | ------------------------------ |
| **argon2id verify p95 < 300 ms** (P-4) | D8 | KDF cost is pure CPU + memory bandwidth. A host core does m=32MiB/t=3 in a fraction of a cheap ARM's time. | **D8's parameter choice is undecided.** v0 ships the `m=32768/t=3/p=1` default *unvalidated*; the documented floor `m=19456/t=2/p=1` exists precisely because the default may exceed the budget on the real device. First real device may force a change to a security parameter. |
| **op-sqlite write throughput** (P-2, 667 ops/s floor) | D6 | Storage path and IO scheduler are the whole measurement; emulated storage is host disk. | **D6's core rationale is unvalidated.** op-sqlite was chosen over expo-sqlite *for* throughput on low-end hardware. The thin wrapper keeping expo-sqlite a swap target (D6) is now load-bearing, not a nicety. |
| **SQLCipher at-rest is real ciphertext** (SEC-DEV-06 L6 leg) | security-guide §6.5 | CI has no SQLCipher at all (better-sqlite3 ships none; op-sqlite is JSI and does not run on this Linux host). An emulator *can* run op-sqlite — so this one is **partially recoverable** on an emulator and should be attempted there. | Task 04's probe is unit-tested against fakes and has never seen a real encrypted DB. |

Also unproven by an emulator: cold start (P-1), projection rebuild (P-3), `execute()` latency (P-5), and the 1-week backlog sync — all report `EMULATOR` figures, useful as regression canaries, worthless as acceptance.

**Note the asymmetry:** SQLCipher at-rest is a *correctness* claim (is it ciphertext — yes/no), and an emulator running op-sqlite can answer it. The other two are *performance* claims, and an emulator cannot. 27a should therefore attempt SEC-DEV-06's L6 leg on an emulator and record the result honestly; that converts our weakest security claim from "unit-tested against fakes" to "observed on a real op-sqlite database".

## Alternatives rejected

- **Declare D4 met on emulator numbers.** Rejected: it is the "green for the wrong reason" pattern (CLAUDE.md §2.11) applied to the exit criterion itself — the one place it would be least recoverable.
- **Delete the device gates.** Rejected: the gates exist because 2GB Android is the product's defining constraint (ARCH-001 §1). Deleting them makes the constraint invisible rather than unmet.
- **Block v0 entirely until a device exists.** Rejected: everything else in the foundation is provable now, and stopping would waste that.

## Open — needs the owner → **ASKED AND DEFERRED 2026-07-15**

- **A cloud device farm** (Firebase Test Lab, AWS Device Farm, BrowserStack App Automate) rents *real physical* low-end Androids and would close 27b without owning hardware. It is a paid, outward-facing service (uploads a build artifact to a third party) — **owner decision, not an agent's**.
- **Owner's call (2026-07-15): defer.** Not rejected — deferred. Nothing stalls; v0 exits as described above with the device clause explicitly unsatisfied.
- **Reopen trigger:** task **27a**'s measured op-sqlite write-throughput margin over the 667 ops/s floor. Thin margin → rent (cost is negligible: Firebase Test Lab is 30 free physical-device min/day on Spark; ~$5/device-hour on Blaze, and the whole gate is minutes). Fat margin → stays deferred to pre-pilot.
- **Sizing correction recorded at the same time:** of the three unproven claims, only **op-sqlite throughput** is genuinely architectural-if-wrong — and note this doc's own D6 mitigation is weaker than it reads, because the swap target (expo-sqlite) is *slower* than op-sqlite, so a throughput failure is not rescued by swapping. **argon2id** is tunable (the documented floor exists for exactly this). **SQLCipher at-rest** is not device-blocked at all — 27a answers it on a real op-sqlite DB. Detail in `ai-docs/OPEN-QUESTIONS.md` §1.
- If a physical device arrives later, 27b runs unchanged; nothing else needs revisiting.

## D13 — JCS byte-identity is proven on Hermes 0.13.0, UNPROVEN on the shipping 0.17.0 (accepted risk)

The SEC-OPLOG-06 lane proves `canonicalize`'s number serialization is byte-identical Node-vs-Hermes **on Hermes CLI 0.13.0** — the newest prebuilt host VM. RN 0.86 ships **Hermes 0.17.0** (`react-native@0.86.0/sdks/.hermesversion` = `hermes-v0.17.0`); `hermes-compiler` ships only `hermesc` (compile-only, cannot execute). Any change to Hermes's `Number::toString`/dtoa introduced in 0.14–0.17 is **structurally invisible to this lane**.

The lane is otherwise honestly built — the vectors do exercise the at-risk number space (`5e-324`, `1.7976931348623157`, `-0`, `9007199254740…`, `e-`/`e+`/`1e`), verified by the reviewer, not taken from the report.

**Accepted risk, closer named — and it is closer than first written.** JCS byte-identity is a property of the **Hermes engine version, not the hardware**: `Number::toString`/dtoa is deterministic per engine build; a faster or slower CPU cannot change which bytes it emits. An Android app bundles its own Hermes (RN 0.86 → **0.17**) into the APK, and an **emulator runs that same APK**, so **emulator Hermes == device Hermes == 0.17**. Therefore the correctness question is fully answerable **without a physical device**: task **27a** (emulator lane, lands in v0) running THESE exact vectors on real Hermes 0.17 closes it. 27b re-runs them on device but cannot change a deterministic result — for JCS identity specifically it only adds a second witness, not new information.

The genuinely device-only claims stay the performance ones (argon2id timing, write throughput) — those depend on the CPU/storage the emulator does not share. **So the corrected risk statement:** JCS byte-identity on the shipping VM is *unproven only until 27a runs* (it lands in v0 — this is not deferred past v0), while everything between task 03 and 27a builds on the 0.13.0 proof; if the vectors diverge on 0.17 the discovery invalidates every signature produced in between, which is why 27a must run the **full** vector set, not a subset. That requirement is written into both 27a and 27b acceptance. Alternative rejected: building Hermes 0.17 from source in CI (heavy, brittle) — the emulator already runs the real 0.17 engine, so it is unnecessary.
