# TASK 176 — the emulator lane's 20-minute red run printed ONE line: make `harness-device.mjs` fail fast on a launch that did not launch, print the adb output it already captures, and dump an unfiltered logcat on the failure path

**Status:** in-progress
**Priority:** HIGH — cheap, independent, and it is what makes the NEXT dispatch informative. Not a fix for the missing producer.
**Depends on:** 175 (the diagnosis this acts on)
**Relates to:** 27a (owns the producer — explicitly NOT this task), 160 (predicts a silent half-enrolled boot; this dump is what can finally see it), 148 (neither implicated nor exonerated by run 29990800850 — this makes the next run able to answer)
**SEC ids owned by THIS task:** none.
**Filed by:** impl-176, 2026-07-24, acting on task 175 leg 5.

---

## Scope — OBSERVABILITY ONLY

This task changes **what the lane REPORTS on failure**, not what it accepts. The 20-minute deadline,
`EMULATOR_REQUIRED_GATES`, and every `parseHarnessResult` assertion are byte-unchanged. Building the
producer (`HarnessActivity` / the emitter / the `EXPO_PUBLIC_` flag rename / the 4 unwired gates) is
task 27a's work and is deliberately **not** here — task 175 §A–D is the diagnosis, this is only its
leg 5.

Files touched: `scripts/harness-device.mjs`, `packages/test-support/src/harness-device.test.ts`.

## What shipped

1. **The launch check is now load-bearing.** `am start` prints `Error type 3` /
   `Error: Activity class {…} does not exist.` on **stdout** and **exits 0**. The old check
   (`if (launch.status !== 0)`) was therefore green for the wrong reason (§2.11) — it "successfully
   launched" a component that has never existed, then polled 20 min 13 s. `amStartFailureReason()`
   now scans stdout+stderr for the failure markers and fails fast, naming the component.
   It is **positive evidence only**: the absence of `Status: ok` is NOT a failure, so a future entry
   point (deep link, `MainActivity`) and a warm-start `Activity not started` warning are not
   pre-rejected.
2. **Captured adb output is printed, not swallowed.** `sh()` still captures (the poll needs logcat as
   a string) and callers still read `.status`/`.stdout` — the contract is unchanged. Every failure
   path now prints the capture via `formatCapture()`: status, signal, spawn error, stdout, stderr.
3. **An unfiltered logcat dump on the failure path only.** The poll's `-s BOLUSI_HARNESS_RESULT:I` is
   a **tag** filterspec that excludes `AndroidRuntime` / `ActivityManager` / `ReactNativeJS` by
   construction, so a crash could never have appeared in it — which is why task 175's search for
   `FATAL EXCEPTION` in the 16 547-line job log proved nothing. `dumpFailureDiagnostics()` now dumps
   `adb logcat -d -b crash` (small, pure signal, survives a process death) and unfiltered
   `adb logcat -d`, each bounded to the last **400** lines.
4. **The tag-vs-substring trap is recorded at the poll**, where whoever builds the producer will hit
   it: `console.log('BOLUSI_HARNESS_RESULT: …')` reaches logcat under tag `ReactNativeJS`, so the
   substring grep would match it but `-s` deletes the line first. **Emitter and filter must be chosen
   together.**

## Falsification (§2.11)

Falsified against a **STUBBED `adb`** (a shell script mimicking real adb/am response shapes) — there
is no emulator on this host. Stated as stubbed; this is not a device run.

| # | did | observed |
| - | --- | -------- |
| a-before | original `origin/main` file, stub `am start` exits 0 with `Error type 3` on stdout (deadline patched 20 min → 8 s so the demo terminates) | **1903** `logcat -d -s` polls, then the two-line CI failure verbatim; zero adb output |
| a-after | same stub, shipped file | **5** adb calls, **0** polls, `EXIT=1`: `am start … did NOT launch (it exited 0 …): Error: Activity class {com.bolusi.app/com.bolusi.app.HarnessActivity} does not exist.` |
| b | stub emits a valid tagged result | positive control intact: `EMULATOR correctness gates PASS (7 gates, target=emulator, hermes=0.17.0)`, `EXIT=0`, **no dump on success** |
| c | stub logcat carries `FATAL EXCEPTION` | surfaced on both failure paths — the failing-adb-step path (unpatched file) and the poll-timeout path (deadline patched for the demo): `FATAL EXCEPTION: main`, `UnsatisfiedLinkError`, `Process com.bolusi.app (pid 4412) has died` |
| d | fed the dump 5000 lines | capped at **400** + `… [4600 earlier line(s) elided — showing the last 400]`; total driver output 418 lines; the kept range is the TAIL (4601–5000) |
| unit-1 | neutered `amStartFailureReason` to `return null` | 2 tests red: `expected null not to be null` — restored, green |
| unit-2 | removed the bound from `tailLines` | 1 test red: `expected [ 'line 1', … ] to have a length of 401 but got 5000` — restored, green |

**NOT verified without a device:** that a real `adb`/`am start` on a real AVD produces these exact
strings; that an unfiltered 20-minute logcat fits the 64 MB `maxBuffer`; that `-b crash` is present
on the API-34 image. All are stub-modelled from documented adb behaviour, not observed on hardware.

## Acceptance

- A launch at a nonexistent component fails in seconds with the component named, instead of polling
  to the deadline. **Falsified (stubbed) — row a.**
- A failing run prints the adb captures and a bounded unfiltered logcat. **Falsified (stubbed) — c, d.**
- The happy path is unchanged and dumps nothing. **Falsified (stubbed) — row b.**
- The deadline, the gate list, and every `parseHarnessResult` assertion are unchanged. **Diff-visible.**
- Node lanes stay green.
