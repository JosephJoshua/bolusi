# TASK 167 — raise the Android emulator lane to API 36 so it exercises the OS version we ship

**Status:** todo
**Priority:** MEDIUM — the lane answers correctness for a different Android version than we ship, which puts an unstated caveat on every claim it produces. Sharper now that task 162 has landed and those gates will execute for the first time.
**Depends on:** 162 (merged — it is what made these gates executable at all; they had never run)
**Relates to:** 27a (the device/emulator gates), 117
**SEC ids owned by THIS task:** none.
**Decision:** **D23 §4** (`ai-docs/decisions/2026-07-23-owner-rulings-push-tap-media-oracle-enroll-cta-emulator-api.md`) — owner ruled **raise the lane to API 36**. Not "keep 34 and document", not "run both". This task is the implementation of that ruling, not an open question.
**Filed by:** the task-150 implementer, 2026-07-23, from the 150 review (item 5 / note 4).

## Deliverable

In `.github/workflows/ci.yml`, the `android-emulator` job's
`reactivecircus/android-emulator-runner@v2` step (`api-level: 34`, currently **line 537**) becomes
`api-level: 36`.

That is the whole change. What follows is why it is not a silent version bump, and what "done" means.

## The finding it closes

Two numbers that did not meet:

- `.github/workflows/ci.yml:537` pinned the emulator to **`api-level: 34`**.
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
the APK targets. Everything behind that gate was dead code in the lane — including the
`OnBackPressedCallback` shim that `ReactActivity.java:29-39` registers, which on a real targetSdk-36
device is *the* delivery path for `hardwareBackPress` (Android 16 no longer calls `onBackPressed` at
all; see `apps/mobile/src/navigation/useHardwareBack.test.tsx`'s limits section for the cited
behaviour change).

So every `isAtLeastTargetSdk36` behaviour was unexercised **by construction**. This was never a lane
that was failing — it was a lane whose green did not mean what its name suggested, the CLAUDE.md
§2.11 shape: an unknown risk converted into a false assurance. Predictive back is one instance; the
gate is generic, and `AndroidVersion.isAtLeastTargetSdk35` exists beside it (edge-to-edge enforcement
at 35 is the obvious neighbour).

## Accepted cost — state it, do not discover it

API 36 system images are newer than 34, so **CI flakiness and longer emulator boot are possible on
the first runs**. That cost was accepted deliberately rather than overlooked.

**Running both 34 and 36 was considered and rejected**: it roughly doubles wall-clock on a nightly
job whose build step alone is ~21 minutes. One level, matching what we ship.

## Expect the first genuinely-executing run to be RED

Nothing in `pnpm harness:device` or the Maestro flows has ever run against a real AVD — task 162
fixed the dash/`pipefail` defect that aborted the step at line 1, so those gates had never executed
at all. A red on the first real run is **progress, not a regression**, and must not be read as one:
it is the first time the assertions have been evaluated. Budget for triage rather than treating red
as "the bump broke CI".

## Falsification requirement (CLAUDE.md §2.11 — this is the acceptance, not a formality)

A dispatched run is the only proof. **Reading the step conclusion is not sufficient** — a green
conclusion is exactly what a silent fallback produces, and this repo has already shipped gates that
were green for the wrong reason.

The log must show the **AVD actually booted at API 36**, not that the step exited 0. Whoever
implements this reports the line from the run log that carries the booted API level (and the run id),
next to the gate results — per §2.1, the number and the `EXIT=` that produced it. If the runner falls
back to another image, or the image is unavailable and the step skips, that must be visible in what
is reported rather than inferred from a conclusion.

## Acceptance

- `api-level: 36` in the `android-emulator` job.
- A dispatched run whose **log** shows the AVD booted at API 36, reported with the run id.
- The gate results from that run reported as observed — including red ones, which are expected first
  time and are not a reason to revert the bump.
- `apps/mobile/src/navigation/useHardwareBack.test.tsx`'s limits section updated once the lane is
  green at 36: it currently says the shim path is unexercised "until the lane runs API 36 per D23
  §4", and that clause should become a statement about what the lane now covers.
