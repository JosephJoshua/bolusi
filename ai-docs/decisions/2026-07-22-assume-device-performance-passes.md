# D21 — Owner ruling (2026-07-22): assume the on-device performance gates pass

**Date:** 2026-07-22 · **Status:** Accepted — owner decision ("let's assume the performance is fine, then continue").
**Amends:** D8 (argon2id KDF parameter choice — now resolved), D6 (op-sqlite throughput rationale — now ratified), D12/D13 (the no-device posture — the PERFORMANCE half is now assumed rather than owed), task 27b's blocking status.

## What the owner ruled

Proceed as if task 27b's Part C performance gates (testing-guide §4.2 P-1…P-6) pass on the physical 2 GB reference device. This unblocks the decisions those measurements were meant to inform.

## THIS IS AN ASSUMPTION, NOT A MEASUREMENT — the rule for every downstream claim

**No measured number may be written anywhere as though it were observed.** No report, decision, artifact, or test may state a p95, a throughput figure, a cold-start time, or a memory ceiling as measured. The only honest form is: *"assumed to pass per D21 (owner ruling, 2026-07-22); unverified on device."* Any agent that finds itself typing a concrete performance figure it did not observe has crossed the line this section exists to draw — the repo's standing rule (CLAUDE.md §2.1) is that a number carries the run that produced it, and here there is no run.

## What this DOES resolve

1. **D8 — argon2id KDF parameters: KEEP THE DEFAULT `m=32768 KiB, t=3, p=1`.** The measurement existed to decide whether the default holds or the documented floor (`m=19456, t=2, p=1`) must be engaged. "Performance is fine" means the default holds — which is the **stronger** of the two options, so the security posture resolves in the conservative direction. This is the safe way for an assumption to land: assuming success keeps the harder parameters, it does not weaken them.
   - **If a real device later shows otherwise**, the fallback is already written: engage D8's documented floor and update `api/02-auth` in the same change. Nothing about that path is lost by assuming.
2. **D6 — op-sqlite over expo-sqlite: ratified.** The write-throughput benchmark existed to validate the choice against the P-2 667 ops/s floor. Assumed met; the `@bolusi/db-client` wrapper keeps expo-sqlite a swap target regardless (that was never contingent on the number).
3. **Task 27b stops BLOCKING v0.** Its gates are recorded as **assumed-pass, device-unverified** — recorded, not deleted (D12's precedent: *"deleting the gates makes the constraint invisible rather than unmet"*). The gate definitions, budget constants, and harness stay exactly as they are so a real device can still run them and either confirm or refute this assumption.

## What this does NOT resolve (do not let it leak)

- **SEC-AUTH-09 leg 1** — "verifier/salt bytes exist only inside the SQLCipher DB" is a **correctness** claim (is the byte on disk ciphertext, yes/no), not a performance one. It needs real SQLCipher, which only the emulator lane (27a) has. **Untouched by this ruling; still pending the CI emulator run.**
- **SEC-AUTH-10's committed benchmark artifact** — the SEC row's acceptance is a *recorded on-device benchmark committed as a build artifact*. An assumption does not produce an artifact. **The id stays on the pending allowlist**, with D21 as the recorded reason. Retiring it against a params-pinning test instead would be moving the yardstick to reach green — precisely what CLAUDE.md §2.11 forbids. It retires when a device produces the artifact.
- **Task 28's roll-up** therefore still cannot close: its allowlist retains SEC-AUTH-09 (emulator-pending) and SEC-AUTH-10 (artifact-pending). Its gate stays honestly red, which is the gate working.
- **Every "unverified on-device" residual-risk sentence stays true** and must not be softened. The product still ships with performance unmeasured on target hardware; D21 records that the owner accepts that risk, not that the risk is gone.

## Consequence for v0 exit

The D4 exit criterion's device clause (revised by D12) had three unproven claims held by 27b: argon2id p95, op-sqlite write throughput, and SQLCipher at-rest on real hardware. D21 covers the first two **by assumption**. The third is at-rest **correctness** and belongs to 27a's emulator lane, not to performance — so it is unaffected here.

**Net:** v0's exit is no longer blocked on a physical device for the performance half. It remains blocked on the emulator lane reporting (27a → SEC-AUTH-09 leg 1) and on task 28's roll-up, both of which are CI events, not hardware purchases.
