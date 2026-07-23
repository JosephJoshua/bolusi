# TASK 167 — the emulator lane runs API 34 while we ship targetSdk 36, so every `isAtLeastTargetSdk36` behaviour is unexercised by construction

**Status:** todo
**Priority:** MEDIUM — the lane answers correctness for a different Android version than we ship. Not a bug in the lane; a gap between what it measures and what users run. Sharper now that task 162 has landed and those gates will execute for the first time.
**Depends on:** 162
**Relates to:** 27a (the device/emulator gates), 117
**SEC ids owned by THIS task:** none.
**Filed by:** the task-150 implementer, 2026-07-23, from the 150 review (item 5 / note 4).

## The finding

Two numbers that do not meet:

- `.github/workflows/ci.yml:537` pins the emulator to **`api-level: 34`**.
- The shipped build targets **`compileSdk/targetSdk 36`** — on record at
  `ai-docs/tasks/148-duplicate-libcrypto-blocks-android-apk.md:89`.

RN 0.86 gates its predictive-back compatibility shim on **both** halves
(`AndroidVersion.kt:51-53`, read from the installed package):

```kotlin
fun isAtLeastTargetSdk36(context: Context): Boolean =
    Build.VERSION.SDK_INT >= VERSION_CODE_BAKLAVA &&
        context.applicationInfo.targetSdkVersion >= VERSION_CODE_BAKLAVA
```

`Build.VERSION.SDK_INT` is **34** on that emulator, so the first conjunct is false regardless of what
the APK targets. Everything behind that gate is dead code in the lane — including the
`OnBackPressedCallback` shim that `ReactActivity.java:29-39` registers, which on a real targetSdk-36
device is *the* delivery path for `hardwareBackPress` (Android 16 no longer calls `onBackPressed` at
all; see `useHardwareBack.test.tsx`'s limits section for the cited behaviour change).

**So the emulator lane cannot exercise predictive back, or any other API-36-gated behaviour, even
once it runs green.** This is not a lane that is failing — it is a lane whose green does not mean
what its name suggests, which is the CLAUDE.md §2.11 shape: an unknown risk converted into a false
assurance. The class is wider than back handling; `isAtLeastTargetSdk36` is one gate, and any other
`SDK_INT`-conditional platform behaviour between 34 and 36 has the same hole (edge-to-edge
enforcement at 35 is the obvious neighbour — `AndroidVersion.isAtLeastTargetSdk35` exists too).

## Why now

Task 162 (merged to main) fixed the dash/`pipefail` defect that meant the lane's correctness gates
had **never executed**. The next dispatch is the first time they genuinely run — so this is the right
moment to decide what API level they should run at, before a green starts being cited.

## Why this is a decision, not a one-line edit

Raising `api-level` is not obviously free:

- **AVD availability** — the runner image must have a system image for the level; 36 images are
  newer and not necessarily present on the same runner generation.
- **Boot time and flake** — emulator cold-boot cost rises with level, and 27a's lane is already the
  slow one.
- **Coverage tradeoff** — `minSdk` is 24. Testing only at 36 trades one blind spot for another; the
  honest answer may be a matrix (one low, one at target) rather than a bump.

So this needs a ruling on what the lane is FOR — regression canary at one level, or fidelity to the
shipped target — not a silent version bump.

## Acceptance

- A decision recorded (in `decisions/`) on which API level(s) the emulator lane runs and why.
- If the lane stays below 36, the limitation is written where a reader of a green would see it — the
  lane's own step and `27a`'s task file — naming `isAtLeastTargetSdk36` as unexercised, so nobody
  cites that green for API-36 behaviour.
- If the lane moves to 36, one behaviour behind the gate is asserted (hardware back reaching JS is
  the natural candidate) — otherwise the bump is unfalsified and we have only assumed it changed
  anything.
- Either way, `useHardwareBack.test.tsx`'s limits section is updated to match the outcome; it
  currently points here.
