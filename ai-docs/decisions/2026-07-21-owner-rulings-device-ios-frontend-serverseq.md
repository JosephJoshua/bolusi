# D20 — Four owner rulings (2026-07-21): device lane, iOS lane, frontend phase, client `server_seq`

**Date:** 2026-07-21 · **Status:** Accepted — owner decisions, in response to the batched questions at 105/113 tasks done.
**Amends:** D12/D13 (the no-device posture — the emulator half is now funded), D18 §5 (the iOS lane — scoped down to the unsigned Simulator half), D17 (frontend deferral — now lifted).

## 1. Device verification (tasks 27a / 27b) → **ENABLE AN ANDROID EMULATOR IN CI FIRST**

An Android emulator lane is provisioned in CI. **27a becomes buildable now.**

- **What this closes:** the emulator-answerable *correctness* subset — SQLCipher at-rest (is the byte on disk ciphertext, yes/no), the SEC-OPLOG-06 JCS vectors on the shipping APK's own Hermes 0.17 (D13), and SEC-DEV-06's L6 leg. It also gives **SEC-AUTH-09 leg 1** a home (verifier bytes exist only inside the SQLCipher DB) — the leg task 28 must otherwise record UNPROVEN, since CI has no SQLCipher (better-sqlite3 ships none; op-sqlite is JSI).
- **What it does NOT close:** every Part C **performance** gate. D12's asymmetry stands — an emulator cannot produce device perf numbers, so **27b (physical lane) stays open**, and with it D8's KDF params and D6's throughput figure. Every emulator figure is labelled **EMULATOR**, never a device number.
- **Consequence for v0 exit:** the exit criterion keeps its on-device residual risk for the perf half, stated not hidden.

## 2. iOS build lane (task 85) → **macOS-CI SIMULATOR LANE ONLY; NO APPLE ACCOUNT**

Build the GitHub Actions `macos-latest` job: `expo prebuild --platform ios` + `xcodebuild` for the **iOS Simulator, UNSIGNED** (Simulator builds need no Apple signing), and boot the app.

- **What this closes:** compile/link errors, does-it-launch, do-permission-prompts-fire, and whether the generated `Info.plist`/entitlements match tasks 83/84/87. Driven entirely from `ci.yml` — no accounts, no rental.
- **Explicitly NOT done now:** the **EAS signed-build lane** and Apple Developer enrollment. So no TestFlight, no signed artifact, and none of the claims that need real-device Keychain/backup semantics (§7.4 "never resurrected", backup-exclusion). Those stay **device-unverified**, per D18 §5's honest ceiling.
- Keep the macOS job lean — macOS runners bill ~10× Linux. Confirm the repo's public/private status for minutes.

## 3. Frontend phase (tasks 82, 96) → **START NOW: 82 FIRST, THEN 96**

D17's deferral ("frontend is later though") is **lifted**. The headless core is verified; the frontend phase begins.

- **Task 82 first** — the media pipeline's MOBILE half (expo-camera capture, signature pad, compression passes, cache→document wiring, drain triggers, background-task registration, pruning actor). This is functional pipeline work more than polish, and task 18 already shipped and falsified the engine beneath it.
- **Then task 96** — NotesList / NoteEditor / NoteDetail: the ergonomics testbed every later module screen copies (design-system §8.6). All four §5 states incl. **unauthorized ≠ empty**, ConfirmSheet archive, optimistic save, rejected-op danger banner, thumbnail download-verify, i18n live-switch.
- **The D17 bar stands:** UI work loads `frontend-design` + `impeccable`; beautiful on **both** platforms (iOS is first-class per D17/D18 §3), not an Android layout in an iOS shell. Screens ship **mounted-render tests** (task 69's lane), not model-only coverage.

## 4. Client `operations.server_seq` (task 51) → **RATIFY THE LOCAL ARRIVAL COUNTER, AND RENAME THE COLUMN**

Task 15's client-side **local, gapless, monotonic arrival counter** is ratified as correct for v0.

- **Why it is correct, not a shortcut:** the client's op stream is scope-**filtered** (api/01 §4.3 — this store's ops plus tenant-scoped ones), so the server's true `serverSeq` values are inherently gappy on a multi-store tenant. `highestContiguousServerSeq` pins `applied_server_seq` at the first hole, so storing real serverSeqs would **freeze the watermark below the first other-store op forever** — a silent stall of the same class as task 46. The resume point is `sync_state.pull_cursor` (the server's `nextCursor`), which is the only value the protocol defines as the resume position; the arrival counter never leaves the device.
- **Rejected:** putting `serverSeq` on the pull wire. `serverSeq` is 05 §2.4 bookkeeping assigned at acceptance — i.e. *after* signing — so it structurally cannot ride inside the signed core, and adding a sibling field would buy the freeze described above.
- **The work (task 51):** ratify in the specs; correct `10-db §9.2`'s comment (both halves of "from push ack / pull" are false today); and **RENAME the client column to `arrival_seq`** so the name stops claiming a meaning it does not have. This is the same decoy class task 76 just removed from `user_prefs.locale` — a DDL name a future reader will trust. Costs a client migration; the server's `server_seq` is untouched and keeps its true meaning.
