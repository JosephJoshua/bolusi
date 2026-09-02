# 2026-09-03 — Owner ruling: D24 option-C premise falsified at the producer → defer device-native CHAOS-03/06/07 to task 198

**Date:** 2026-09-03
**Asked by:** impl-181, having built CHAOS-01 device-native (HEAD `3ec8c8f`) and reached step 2 (CHAOS-03/06/07). Before wiring them I traced D24 option C's premise to a producer and it did not hold; I surfaced the blocker rather than build unfalsifiable infra (§2.11 / §6).
**Status:** BINDING. Corrects — does not erase — D24 (`2026-09-02-owner-ruling-181-device-server-chaos.md`), which is forward-linked to this note. D24's rejection of options A (device-embedded fake server) and B (de-scope off L6) still stands; only its factual premise ("the device already reaches a host `@bolusi/server`") is retracted.

---

## What was falsified

D24 ruled CHAOS-03/06/07 run on-device against the REAL host `@bolusi/server` on the stated premise (D24 lines 13, 17–18):

> "The device already reaches it — the P-3 perf gate runs the in-app harness against that host server over lab Wi-Fi."

Traced to producers on 2026-09-03, that path **does not exist** — four independent misses, the T-16 "a mention is not a producer" class (CLAUDE.md §2):

1. **No socket.** `packages/harness/src/server.ts:187` — `HarnessServer.fetch` is `(input, init) => Promise.resolve(app.request(input, init))`; the file header (line 3) says it is *"reached ONLY via `app.request` (no sockets)."* The "harness server" is an in-process Hono handler over PGlite, not a networked host.
2. **No listener.** No producer wraps it in a TCP server — `grep -rE "@hono/node-server|serve\(|listen\(|createServer" packages/harness/src apps/mobile/src` → nothing.
3. **No device→host mapping.** No `10.0.2.2` / `adb reverse` / host-IP route anywhere — `grep -rE "10\.0\.2\.2|adb reverse" packages apps scripts` → nothing.
4. **No HTTP device-enrollment.** Synthetic devices are minted in-process by `HarnessServer.seedDevice` (`server.ts:196`, direct `INSERT INTO devices … signing_key_public`) returning `bdt_harness_*`; a real device has no HTTP path to obtain a device token.

And the gate D24 cited as proof — testing-guide §4.2 **P-3** (line 322, the exact citation) — has **never run**: the D21 status block (2026-07-22) states *"No gate in this table has been run … no p95, no ops/s … exists for any row."* Read to its source, D24's own citation refutes the claim. The device→host Wi-Fi sync path is spec design intent (§2.6 line ~99) with no producer.

## Ruled → defer to a filed task

- **Task 181 is rescoped to its shipped deliverable: CHAOS-01 device-native, client-only** (`3ec8c8f`; falsified via drop-op divergence + refolds=0 INCONCLUSIVE in `chaos-01-device-env.test.ts`). It is marked **done**.
- **CHAOS-03/06/07 are deferred to new task 198**, which builds the missing host-network transport FIRST (socket-exposed `HarnessServer` + out-of-band synthetic-device token handoff + device→host mapping), then the three runners on top. They already PASS on Node against `@bolusi/harness`'s in-process `HarnessServer` — the correctness property is proven; only the device-native execution is deferred.
- **They stay HONEST device-lane skips** in the meantime (`run.ts` `skipDetailFor` → task 198). No fabrication, no unwatched-red infra — the exact §2.11 posture: an honest skip beats a green built on a path nothing exercises.
- **The testing-guide §2.6 amendment D24 authorized is deferred WITH the runners** (§2.11 — no over-claim ahead of a producer). It lands in task 198's commit, gated on a runner watched go RED — not now.

## Why not just re-rule option B (de-scope) or build it anyway

- **Not de-scoped (B).** The correctness delta L6 exists to prove — the physical-device sync client under merge/replay/conflict — is still worth the lift; it is filed, not abandoned. D24's reasoning against B stands.
- **Not built now.** The BUILD of steps 1–3 is host-side Node infra (doable), but step 2 hands out device tokens over the network — a **security surface** (§2.5) that must ship with adversarial tests before review — and step 4's GREEN capture is emulator-lane (no AVD on the dev host, same gate as 27a/178). Bundling that into 181's tail commit would either ship an untested transport or an unfalsifiable runner. A clean filed task is the honest unit.

## Consequences / sequencing

- **`run-and-emit.ts` is deliberately NOT edited.** It is an AT_REST_SURFACE file (`device-gate-provenance.ts:90`); editing it stales SEC-AUTH-09 leg-1 provenance until the next emulator re-anchor (memory `bolusi-at-rest-surface-provenance-stale`). Its comment already defers detail to `run.ts`, which now carries the task-198 pointer. Task 198 (which wires the three runners into `buildDeviceRunners` there) will incur that stale — expected, sequence with 182's sha-stamping.
- **Dependencies:** 198 depends on 181 (the CHAOS-01 device rig + the runner seam) + 178 + 27a, and blocks 27a's CHAOS-03/06/07 gates + the §2.6 L6 exit line + 28.
- **Node lanes unaffected:** the Node harness CHAOS-03/06/07 scenarios stay green; only the device lane skips.
