# Open questions for the owner — batched

Standing instruction: build autonomously, batch questions rather than interrupt. This is the batch. It is a file, not a chat message, because context gets compacted and a lost question is worse than an asked one.

**Last updated:** 2026-07-15 · **Status:** 11/33 tasks done, 6 in flight

---

## 1. The only question that actually blocks something: a cloud device farm

**Ask:** Do we rent real physical low-end Androids (Firebase Test Lab / AWS Device Farm / BrowserStack App Automate), or accept that v0 ships with three claims unproven?

**Why it's yours and not mine:** it's paid, and it uploads a build artifact to a third party — outward-facing (CLAUDE.md §6).

**Why it matters more than it sounds.** You said you have no physical 2GB Android. D4 made "the reference module running on a physical 2GB Android" *half the v0 exit criterion*, so that half is currently unmeetable — recorded in D12 rather than laundered through an emulator. An emulator runs on this host's x86 cores with host RAM; for CPU/storage/memory-bound numbers it doesn't produce conservative estimates, it produces **unrelated numbers**.

Three claims stay unproven until a real device exists (D12):

| Claim | What stays undecided |
| ----- | -------------------- |
| argon2id verify p95 < 300 ms | **D8's KDF parameters are undecided.** v0 ships `m=32768/t=3/p=1` unvalidated. The documented floor `m=19456/t=2/p=1` exists precisely because the default may blow the budget on real hardware — so first contact with a device may force a change to a *security* parameter. |
| op-sqlite write throughput (667 ops/s floor) | **D6's whole rationale is unvalidated.** op-sqlite was chosen over expo-sqlite *for* low-end throughput. The thin wrapper keeping expo-sqlite swappable is now load-bearing, not a nicety. |
| SQLCipher at-rest is real ciphertext (SEC-DEV-06) | Partially recoverable — an emulator *can* run op-sqlite, so task 27a will attempt it. Today this security claim is unit-tested against fakes and has never seen a real encrypted DB. |

**If the answer is no:** nothing stalls. v0 exits on 26 + 28 + 27a with the device clause explicitly *deferred, not satisfied*, and every emulator figure labelled `EMULATOR — NOT A DEVICE MEASUREMENT`. Task 27b stays blocked, not deleted, so the gap stays visible. If a device ever arrives, 27b runs unchanged.

**My recommendation:** rent one. Two of the three claims are load-bearing architecture decisions (D6, D8) currently resting on assumption, and D8's is a security parameter. A single device-farm run converts all three from "assumed" to "measured."

---

## 2. Rulings I made in your absence — worth an audit, especially D14

You said don't stop to ask, so I ruled these. They are recorded in full in `ai-docs/decisions/`. Flagging them here because they're the ones a reasonable owner would want to have been asked about.

- **D14 — the auth path deliberately crosses the tenant boundary.** *This is the one to read.* The identity control plane is isolated by Postgres RLS FORCE, and the app role is NOBYPASSRLS. But login and token-verify must read a row whose tenant is *unknown until the read succeeds* (opaque tokens carry no tenant; `loginIdentifier` is globally unique by design). As specified, **the server literally could not authenticate anyone** — the spec was internally unbuildable. I ruled three narrow `SECURITY DEFINER` functions (one keyed lookup each, fixed columns, fail-closed) over the simpler "give the app a BYPASSRLS role", because the latter means one forgotten `WHERE` reads every tenant. The bypass surface is now three auditable function bodies instead of an open connection. It is still, deliberately, a hole in our most important invariant — review-02 is attacking it as the crown-jewel security surface right now.
- **D11 — identity is server-administered directory data, not event-sourced.** Users/roles/PIN-verifiers go through online-only REST; PIN hashes never enter the op log. This resolved the largest cluster of spec-review findings.
- **D12 / D13 — no device (above), and JCS byte-identity.** D13's good news: JCS byte-identity is a property of the *Hermes engine version, not the hardware*, and an emulator runs the same Hermes 0.17 the APK bundles. So task 27a closes it inside v0 — no device needed. It is unproven only until 27a runs.

---

## 3. Not questions — just things you'd want to know

- **The system had no password storage at all.** Task 13 discovered `users.password_verifier` never existed, while D14's login function was specified to read it. The spec described authenticating against a column nobody had written. Second time the identity control-plane spec proved internally unbuildable (D14 was the first).
- **Five guards have shipped green for the wrong reason** (SEC-META-01 matching file content not test titles; the codegen-diff gate made permanently unsatisfiable by prettier reformatting its own input; a boundary rule that exempted the very files it protected; `badOwners` accepting a task that *disclaimed* a SEC id; a codegen sweep looping over a parse that checked zero properties). The pattern was consistent enough to become a hard rule: **a guard is only load-bearing if someone has watched it go red** (CLAUDE.md §2.11). Every guard is now falsified — broken, watched fail, restored — before it's believed. This is the single highest-value discipline the project has adopted.
- **Reviews are finding real bugs, not nits.** Task 05 caught that the default `CamelCasePlugin` maps `opAId` → `op_aid`, not `op_a_id` — my own review reasoning had missed it, and it would have silently mismapped two columns.
