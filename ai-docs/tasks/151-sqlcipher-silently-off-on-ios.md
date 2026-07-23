# TASK 151 — SQLCipher is SILENTLY OFF on iOS: the podspec never finds the `op-sqlite` config block, so the iOS build ships an UNENCRYPTED client database

**Status:** todo
**Priority:** **HIGH — security.** At-rest encryption of the entire client DB is disabled on one platform, with no error, no warning, and a green CI lane over it. This is also why that lane is green: it is not demonstrating that the iOS OpenSSL collision is resolved, it is demonstrating that op-sqlite never links OpenSSL there.
**Depends on:** 85 (whose lane surfaced it), 148 (the sibling collision on Android)
**Blocks:** any honest claim that the iOS build matches the Android security posture
**SEC ids owned by THIS task:** none currently named — **check `security-guide.md` for the at-rest/SQLCipher row and claim it**; if the SEC list has no id covering "the DB is actually encrypted on every shipping platform", that is itself a gap worth reporting.
**Filed by:** the task-148 investigator, 2026-07-22, from the FIRST-EVER completed runs of both native lanes.

## The evidence — same run, two lanes, opposite outcomes

`ios-simulator` (job 88832033270):
```
[OP-SQLITE] Configuration found at /Users/runner/work/bolusi/bolusi/package.json
[OP-SQLITE] using pure SQLite
```

`android-emulator` (same run):
```
[OP-SQLITE] Detected op-sqlite config from package.json at: .../apps/mobile/android/../package.json
[OP-SQLITE] using sqlcipher.
```

**One config block, two different discovery algorithms.** `android/build.gradle` starts at `new File("$rootDir/../")` = `apps/mobile` and finds it. `op-sqlite.podspec` walks up from its own `node_modules` location, which under **pnpm** bottoms out at the **repo root** `package.json` — which has no `op-sqlite` key. The block lives at `apps/mobile/package.json:14`; op-sqlite's own docs say to put it in *"the monorepo root package.json if applicable."*

## Why this matters three ways

1. **The iOS build ships an unencrypted client database.** Every at-rest guarantee is false there.
2. **The `ios-simulator` lane is green for the wrong reason.** `08-stack-and-repo.md` §2 warns "watch iOS duplicate-symbol conflicts if another dep links SQLite" — that collision has *never been exercised*, because op-sqlite isn't linking OpenSSL on iOS at all. It appears the moment this config is fixed. Expect task 148's problem to arrive on iOS too.
3. **`08-stack-and-repo.md` §7 bootstrap record 4 asserts** *"the podspec confirms the `package.json` `op-sqlite` config block drives `sqlcipher`/`performanceMode`."* The podspec **supports** the mechanism; it was never traced to the produced artifact. Textbook CLAUDE.md §2.11 — the comment was the guard. **No test asserts the block's location or the resulting build flavour.**

## Deliverable
Make the config discoverable on both platforms (most likely: the block moves to, or is mirrored in, the repo-root `package.json` — verify against op-sqlite's current docs via Context7 rather than guessing, since the two discovery algorithms differ). Then **prove the produced build is encrypted**, per platform.

## FALSIFY (§2.11 — REPORT it)
- **The build log line is the minimum, not the proof.** `using sqlcipher.` on both lanes is necessary; it is not sufficient. The real assertion is behavioural: a DB opened with the wrong key must FAIL, and the on-disk bytes must not be readable as plaintext SQLite. That is SEC-AUTH-09 leg 1's territory and needs a real device/emulator.
- Add a gate that reds when the config block is not found by either build system — the current failure mode is a log line nobody reads. Break it (move the block back) → the gate must red on both platforms.
- **Expect a new failure when you fix this:** iOS will start linking OpenSSL and may hit the same duplicate-`libcrypto` collision as task 148. That is not a regression you caused; it is the collision becoming visible. Report it and coordinate with 148 rather than reverting.

## Note
Task 85 was closed on this lane's green. That closure remains correct about what it claimed (compile/link, CocoaPods, `Info.plist` vs tasks 83/87, does-it-launch) — but it must be read knowing SQLCipher was **off** in that build. The task-85 file has been annotated.

---

## RE-SCOPED 2026-07-22 by task 148 (D22): the SECURITY half of this task is DISSOLVED, not fixed — do not close it, and do not work the old premise

Task 148 landed D22: **`sqlcipher` is now OFF on BOTH platforms, deliberately.** op-sqlite's SQLCipher build vendored a second `libcrypto.so` that collided with react-native-quick-crypto's and made the Android APK unassemblable, so at-rest confidentiality moved to **application-layer AES-256-GCM over the sensitive columns** (10-db §9.7; security-guide §6.4), keyed by the same 32-byte SecureStore key.

**What that does to this task:**

1. **"iOS ships an unencrypted client database" is NO LONGER A BUG — the premise is gone.** The encryption is now platform-agnostic JavaScript running through quick-crypto (which iOS links anyway), so it applies identically on iOS and Android. There is no longer a "SQLCipher on/off" state for the podspec to get wrong, and the two platforms' at-rest posture is now the same by construction rather than by configuration.
2. **The "expect this same collision on iOS the moment 151 is fixed" warning is PRE-EMPTED.** op-sqlite links no OpenSSL on either platform now, so fixing the config discovery cannot resurrect the collision.
3. **The ROOT CAUSE SURVIVES and is this task's REMAINING SCOPE.** The podspec's config discovery walks to the pnpm repo root and never finds the `op-sqlite` block at `apps/mobile/package.json`. That block still exists and still carries **`performanceMode: true`**. So the live question is no longer "is SQLCipher on?" but **"is `performanceMode` actually discovered and applied on iOS, or is it silently dropped the same way `sqlcipher` was?"** — a D6 performance-pin question, not a security one.
4. **The SEC-id hunt in the header is ANSWERED and should not be pursued as written.** The at-rest row is `SEC-DEV-06`, it is owned by the 148 lane, and D22 reshaped its claim (sensitive VALUES ciphertext; structure plaintext). This task claims no SEC id.

**Re-scoped title/goal:** *prove `performanceMode` is discovered and applied on iOS* (and, while in there, that the config-discovery walk is fixed or documented as unfixable for a pnpm workspace). **Priority drops from HIGH-security to a performance/config correctness item.** The old security framing above is retained as the historical record of how this was found — it is no longer the work.
