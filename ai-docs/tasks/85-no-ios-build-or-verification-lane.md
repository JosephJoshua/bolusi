# TASK 85 — iOS is a declared platform with no way to build it and no target to run it on: `08 §5.5`'s four profiles are Android-APK **by spec**, and all 10 CI jobs are `ubuntu-latest`

**Status:** done

> **OWNER RULING (2026-07-17):** BOTH lanes (D18 §5): GitHub Actions `macos-latest` (unsigned Simulator build + boot — I write the CI job, verifies tasks 83/84/87's generated Info.plist) AND EAS Build (signed real-device/TestFlight). **Coding waits on impl-ios (83/84/87) landing the iOS `app.config.ts` block.** **OWNER PROVISIONING (the gate, see D18 §5): Apple Developer Program (\$99/yr, 24-48h), an Expo/EAS account, GitHub macOS minutes enabled, and eventually a physical iPhone for the on-device §7.4/backup claims the Simulator cannot verify.**

**Priority:** **HIGH — the precondition for every other iOS leg.** Tasks 83 and 84 can each land a config value and an artifact guard, but **nothing about iOS can be verified on a target** until this is answered. It also carries an owner decision.
**Depends on:** —
**Blocks:** 83's on-target verification, 84, task 27's iOS lanes
**SEC ids owned by THIS task:** none.
**Filed by:** task 80 (iOS parity audit), 2026-07-16, under **D17**.

## The finding — three independent layers, each Android-only, none of them lying

**1. The spec itself, not just the file.** `08-stack-and-repo.md §5.5` defines the four EAS profiles, and **every one of them says Android**:

| Profile | §5.5's own words |
| ------- | ---------------- |
| `development` | `developmentClient: true`, internal distribution, **Android APK**, channel `dev` |
| `preview` | release build, internal distribution, **Android APK**, channel `preview` |
| `test` | `preview` settings + `env: { BOLUSI_TEST_HARNESS: "1" }` |
| `production` | placeholder only |

So `apps/mobile/eas.json` — which carries `"android": { "buildType": "apk" }` and **no `ios` key in any profile** — is *spec-correct*. The Android-only-ness is in `08 §5.5`. Fixing `eas.json` without fixing §5.5 would put the file and its spec in conflict, and §5.5 is the owning doc.

`test/eas-profiles.test.ts` asserts `android.buildType` on three profiles and has a denominator check (T-14) that no fifth profile crept in. **It is a good gate. It has no iOS assertion because there is no iOS to assert** — the gate is honest; the spec beneath it is the Android-only thing.

**2. CI cannot build iOS.** `.github/workflows/ci.yml` — **10 jobs, all `runs-on: ubuntu-latest`.** There is no macOS runner. iOS is not built, not typechecked against an iOS target, not tested, and not linted for platform-conditional behaviour anywhere in the pipeline.

**3. This environment cannot run iOS at all.** The host is `Linux … x86_64`, with no `sw_vers` and **no `xcrun`/`xcodebuild`**. An iOS Simulator requires macOS + Xcode. So there is no Simulator lane to fall back on — see task 80's device-gap statement, which is the wording to reuse.

**None of these is a mistake.** Each is a correct, honest artifact of an Android-first product (`00-product-overview:41`). **D17 changed the premise, and no layer has caught up.** That is the whole point: `platforms: ['android', 'ios']` has been true in the config, `z.enum(['android','ios'])` accepts an iOS enrolment on the wire (`api/02-auth:125`), `10-db-schema:518` will store `platform = 'ios'`, and `index.ts` will *report* `'ios'` (`Platform.OS === 'ios' ? 'ios' : 'android'`) — an end-to-end iOS path that is declared, typed, stored, and **unreachable**, because no iOS binary can be produced.

## Scope

**In:** the decision + the lane. `08 §5.5`'s profile table gaining an iOS column (or an explicit statement that v0 is Android-only), `eas.json`'s profiles, and whichever CI/build capability the owner's answer implies.

**Out:** the `ios` block itself (task 83), the security controls (task 84), the residual-risk wording (task 86), any UI (deferred by D17).

## The owner decision this needs FIRST (CLAUDE.md §6 — paid, outward-facing, hard-to-reverse)

**Building iOS requires macOS hardware this project does not have.** The options, and none is an agent's call:

| option | what it costs | note |
| ------ | ------------- | ---- |
| **EAS Build (cloud macOS workers)** | paid; **uploads the source/build artifact to a third party** — CLAUDE.md §6 red flag, the same shape as D12's device-farm question | the standard answer for Expo, and the project already uses EAS profiles + channels |
| **A physical Mac + Xcode** | capex; also the only way to run a Simulator locally | |
| **Declare v0 Android-only and defer iOS to v1** | free; **and it is a legitimate answer** — D17 says iOS is first-class and also says *"frontend is later though"* | if chosen, say it **in `08 §5.5` and `00-product-overview`**, so the declaration stops out-running the verification. This is the option that makes the other three tasks smaller. |

**Note the honest framing:** D17 rules that iOS is first-class; it does **not** rule that v0 ships iOS. Those are different claims, and conflating them is what produced the current state. **Bring the recommendation; do not pick silently.**

**D12's precedent applies directly.** The owner was asked about a cloud device farm (a paid, outward-facing service that would close task 27b) and **deferred** — not rejected. The same question, for the same reason, now has an iOS half. Batch it with that one rather than asking twice.

## Docs to read

- `ai-docs/decisions/2026-07-16-ios-is-a-first-class-target.md` (**D17**).
- `ai-docs/decisions/2026-07-15-no-device-v0-exit.md` (**D12/D13**) — especially the deferred device-farm question and *why an emulator cannot stand in*; the reasoning transfers.
- `ai-docs/tasks/80-*.md` §Outcome — the parity table and the exact device-gap wording.
- `08-stack-and-repo.md` **§5.5** (the owning doc) and **§5.6** (the CI stage outline).
- `.github/workflows/ci.yml`, `apps/mobile/eas.json`, `apps/mobile/test/eas-profiles.test.ts`.

## Acceptance

- **The owner's answer is recorded as a decision doc** (`decisions/`, dated) before any lane is built — it is the premise every downstream task rests on, and D17 exists precisely because an unrecorded premise let a correct ruling go quietly wrong.
- Whatever is decided, **`08 §5.5` and `eas.json` agree afterwards**, and `eas-profiles.test.ts`'s denominator still fails on an undeclared profile. **Falsify it** if it changes: add a fifth profile → red; revert → green.
- **If v0 stays Android-only:** `platforms: ['android', 'ios']` must not keep claiming what nothing builds. Either drop `'ios'` from the list until there is a lane, or state in `08 §5.5` that the declaration is forward-looking and unverified. **A declaration nothing checks is this repo's signature failure** (D17 §The honest note) — the fix is allowed to be "say less", and here that is probably the cheapest correct answer.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green. Read the output, not the exit code (§2.1).

## Note

The instructive part is that **every artifact here is individually honest**. §5.5 says "Android APK" because it meant it. `eas.json` matches §5.5 because a gate makes it. The gate asserts `android.buildType` because that is what §5.5 specifies. CI runs `ubuntu-latest` because there was never an iOS build to run. Each link is correct, each was reviewed, and the chain composes into a platform the config has claimed for the entire life of the repo and that no layer can produce.

**Nothing here is a bug to find. It is a premise to change, and premises are the owner's.** Which is exactly why the deliverable of this task is a *decision doc*, not code.


---

## CLOSED 2026-07-22 — the lane has now RUN, which is the one thing that was missing

Every other acceptance bullet had been satisfied for days; what had never happened was the lane executing. `.github/workflows/ci.yml` gates `ios-simulator` on `schedule || workflow_dispatch`, and **no such run had ever completed** — the sole scheduled run in the repo's history (29804441399) was cancelled. So this task sat `in-progress` against a job with no evidence behind it, which is the same "declaration nothing checks" failure its own §Note warns about, one level up.

The orchestrator dispatched it manually. Two real defects surfaced and were fixed, each read from the lane's own log:

1. **`./gradlew: No such file or directory` (exit 127)** on the Android lane — `expo prebuild` writes the wrapper to `apps/mobile/android`, and the step invoked it from the repo root. Fixed in `fix(ci): invoke the gradle wrapper at apps/mobile/android, not the repo root`.
2. **`While trying to resolve module '@bolusi/core' … packages/core/dist/index.js … does not exist`** — Metro resolves the workspace packages through `dist/`, and neither native job built them. Fixed in `fix(ci): build workspace packages before the native lanes bundle with metro` by adding `npx tsc -b`, the same build every `test:*` script runs.

**Run 29891270836, `ios-simulator`: SUCCESS — every step:**

```
success  build workspace packages (Metro resolves @bolusi/* through dist/)
success  expo prebuild (iOS native project)
success  pod install
success  xcodebuild — unsigned iOS Simulator build (Release)
success  verify built Info.plist matches tasks 83/87
success  boot Simulator, install + launch the app
```

**What this closes:** compile/link on Apple's toolchain, CocoaPods integration, the generated `Info.plist`/entitlements against tasks 83/87, and does-it-launch. **What it does NOT close, unchanged:** every device-only claim in D18 §5 / D20 §2 — real-device Keychain behaviour, backup/restore, security-guide §7.4's "never resurrected". **No Simulator green is a device test**, and no iOS *behaviour* was driven: nothing tapped a screen. The lane proves the app builds and starts, nothing more.

**Still true and deliberately unchanged:** `eas.json` carries no `ios` block (the Simulator lane is `xcodebuild`-driven and reads nothing from it); the signed-device/TestFlight lane stays owner-deferred per D20 §2; `test/eas-profiles.test.ts`'s denominator still pins exactly four Android profiles.


### CORRECTION 2026-07-22 (same day) — read this closure knowing SQLCipher was OFF in that build

The task-148 investigation read the `ios-simulator` lane's own log and found:

```
[OP-SQLITE] Configuration found at /Users/runner/work/bolusi/bolusi/package.json
[OP-SQLITE] using pure SQLite
```

The podspec's config discovery walks to the **pnpm repo root**, which has no `op-sqlite` key; the block lives at `apps/mobile/package.json:14`. So the build this closure cites was produced **without SQLCipher** — tracked as **task 151**.

**What that does and does not change here.** The claims made above stand exactly as written: compile/link on Apple's toolchain, CocoaPods integration, the generated `Info.plist`/entitlements against tasks 83/87, and does-it-launch — none of those depend on the SQLite flavour. **What it removes is an inference nobody should draw from the green:** `08 §2` warns of iOS duplicate-symbol conflicts when another dependency links SQLite, and this lane did **not** exercise that, because op-sqlite was not linking OpenSSL at all. Expect task 148's Android collision to appear on iOS once 151 is fixed.

This is the §2.11 pattern one level up: a lane that is green for a reason other than the one its reader assumes.
