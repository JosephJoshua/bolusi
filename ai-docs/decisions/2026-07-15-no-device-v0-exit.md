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

## Open — needs the owner

- **A cloud device farm** (Firebase Test Lab, AWS Device Farm, BrowserStack App Automate) rents *real physical* low-end Androids and would close 27b without owning hardware. It is a paid, outward-facing service (uploads a build artifact to a third party) — **owner decision, not an agent's**. Recorded as the recommended path if no device is coming.
- If a device arrives later, 27b runs unchanged; nothing else needs revisiting.
