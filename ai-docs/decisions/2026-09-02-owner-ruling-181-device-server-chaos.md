> **⚠ SUPERSEDED IN PART (2026-09-03) — see `2026-09-03-defer-device-host-network-chaos-to-198.md`.** This ruling's factual premise — "the device already reaches a host-run `@bolusi/server`; the P-3 perf gate already hits it over Wi-Fi" (lines 13, 17–18) — was **falsified at the producer**: the harness server is an in-process `app.request` handler with no socket, no listener binds it to a port, no device→host mapping exists, no synthetic-device HTTP enrollment exists, and P-3 has never run. The device→host Wi-Fi sync path is spec intent with no producer. Owner ruled (2026-09-03): CHAOS-03/06/07 are **deferred to task 198** (build that host-network transport first); task 181 keeps only CHAOS-01 (shipped). D24's *rejection of options A and B still stands* — only the premise is retracted. Read the body below as the original ruling, not current truth.

# D24 — Owner ruling: task 181 CHAOS-03/06/07 run on-device against the REAL server (option C)

**Date:** 2026-09-02
**Asked by:** orchestrator, teeing up the single §6 fork in `181-device-native-chaos-harness.md` line 24 at the owner's request.
**Status:** BINDING. Supersedes the "decide the fork" step in task 181 and authorizes the testing-guide §2.6 amendment described below (to land WITH the runners, not ahead of them).

Task 181's Deliverable step 2 posed a fork for the three server-bound chaos scenarios (CHAOS-03 days-offline merge, CHAOS-06 duplicate-replay, CHAOS-07 concurrent-edit conflict): (a) build a device-embeddable server-equivalent, or (b) rule them off the single-emulator L6 set and amend §2.6. A third option surfaced while teeing up the ruling and became the choice.

---

## Ruled → **C: drive CHAOS-03/06/07 on the physical device through the app's REAL sync client against the REAL `@bolusi/server` host**

The three server-bound scenarios stay ON the L6 physical-device run. They exercise the mobile app's **real** sync client, driving N logical devices as **N in-process `@bolusi/core` engine instances** (each its own keypair), all syncing over Wi-Fi to the **real production `@bolusi/server`** — the same "§2.6 harness server" the P-3 perf gate already hits (`packages/harness/src/server.ts:1` = "the REAL production `@bolusi/server`"; testing-guide §2.6 line 322 = "in-app harness against the §2.6 harness server"). No fake server, no server-less emulator claim.

**Two facts corrected task 181's framing and drove the choice:**

1. **The "harness server" is the real server, run on the host** — not a stand-in. So talking to it is production-parity, not a shortcut.
2. **The device already reaches it** — the P-3 perf gate runs the in-app harness against that host server over lab Wi-Fi. So task 181's stated blocker 2 ("CHAOS-03/06/07 need a SERVER round-trip a single emulator does not have") is **too pessimistic**: the emulator/device CAN do a host-server round-trip. The genuine residual is (i) orchestrating multiple logical devices from one physical device, and (ii) keeping `@bolusi/harness` (PGlite + better-sqlite3) out of the shipping bundle — blocker 1, which stands and is why the driver is rebuilt device-natively rather than imported.

## Why the alternatives were rejected

- **(A) device-embedded server-equivalent — rejected.** A second, in-process server that is NOT `@bolusi/server` proves nothing about the real sync path: it is the textbook §2.11 "green for the wrong reason" — a large lift to build a runner whose green would be unattributable to the production server. The real server already exists on the host; embedding a fake beside it is negative value.
- **(B) de-scope off L6 — rejected.** It is honest and small, but it forgoes exactly the delta L6 exists to prove: the **physical-device sync client** under merge / replay / conflict. The emulator+host-server lane (L2/L3) already exercises the server round-trip; C additionally proves the device client does the same. At the v0 tail the owner judged that parity worth the lift. B was the fallback if the lift were prohibitive; the host-server-already-reachable fact made C tractable, so B is not taken.

## What this changes

- **Task 181 is re-scoped** from "decide the fork" to "build the device-native chaos rig that runs CHAOS-01 client-only AND drives CHAOS-03/06/07 through the app's real sync client against the host `@bolusi/server`." The `(a)/(b)` fork in its Deliverable is resolved to C.
- **testing-guide §2.6 amendment is AUTHORIZED but lands WITH the runners, not now.** The amendment clarifies that on the L6 device run, CHAOS-01 is client-only (assert `device digests == canonical-fold reference`) and CHAOS-03/06/07 run against the §2.6 host harness server (the real `@bolusi/server`) over Wi-Fi — NOT server-less on a single emulator. Writing that into §2.6 **before** a producer exists would make the exit line read as satisfiable when nothing satisfies it (§2.11 — no over-claim ahead of impl); so the prose change is part of 181's landing commit, gated on a runner watched go RED.

## Consequences / sequencing

- **Still infra-gated.** The runners' RED falsification needs a real device/emulator the dev host lacks (no AVD — same gate as 27a/178). The BUILD of the device-native driver bodies + Node-level falsification of the detection logic is host-doable; the on-device green capture (`reports/device-gates/…`) is emulator-lane work.
- **Dependency unchanged:** 181 still depends on **178** (the `resolveGateResults` runner seam) and still **blocks 27a**'s four chaos gates.
- **CHAOS-01 is unaffected** by this ruling — it lands client-only regardless (task 181 Deliverable step 1).
- Until the rig lands, the four chaos gates stay HONESTLY `skipped` with their 178 reason — never faked (§2.11).
