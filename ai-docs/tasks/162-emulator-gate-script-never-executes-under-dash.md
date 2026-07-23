# TASK 162 — the Android emulator lane's correctness gates have NEVER executed: the `script:` dies on its own first line under `/usr/bin/sh`

**Status:** in-review
**Priority:** **HIGH — blocks 27a, 27b, 28, 117.** Not a flake and not a crypto problem: the step fails before running one assertion. It is the last thing between this project and its first-ever emulator correctness run.
**Depends on:** 148 (must merge first — the APK only assembles with 148's SQLCipher removal)
**Blocks:** 27a, 27b, 28, 117
**SEC ids owned by THIS task:** none.
**Filed by:** orchestrator, 2026-07-22, from CI run **29949061877** (`workflow_dispatch` on `ci-probe/148`, sha `4e8ce0a`) — the first run in which the APK ever built.

## Ground truth (read from the job log, job id 89021867602)

The build now WORKS:
```
BUILD SUCCESSFUL in 20m 59s
APK=apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

The very next step fails immediately:
```
[command]/usr/bin/sh -c set -euo pipefail
/usr/bin/sh: 1: set: Illegal option -o pipefail
##[error]The process '/usr/bin/sh' failed with exit code 2
```

`reactivecircus/android-emulator-runner@v2` runs its `script:` input through **`/usr/bin/sh`**, which on
ubuntu-latest is **dash**. Dash implements POSIX `set` and has no `pipefail`. So the script aborts on
line 1 with exit 2, and **`pnpm harness:device`, `adb install` and `maestro test` never run.**

## Why this was invisible until now (the point — testing-guide T-14, "a loud bug masks silent ones")
Every prior run of this lane died EARLIER, at `mergeReleaseNativeLibs` on the `libcrypto.so` collision
(task 148). The dash incompatibility has been present since the step was authored; it only became
*reachable* once the louder failure was fixed. **Every claim resting on "the emulator correctness
gates" has therefore never had evidence behind it** — the gates are not weak, they are unrun.

## Deliverable

Move the inline script out of the workflow into a real file with a bash shebang, and invoke it:

```yaml
script: bash scripts/emulator-gates.sh
```
```bash
#!/usr/bin/env bash
set -euo pipefail
```

**Do NOT "fix" this by dropping `pipefail`.** That is the verifier boundary: `set -euo pipefail` is
what makes a red harness or a red Maestro flow fail the JOB (the step's own comment calls it the
§2.11 fail-safe). Removing it to satisfy dash would convert a broken gate into a silent one — strictly
worse. Preserve the semantics exactly; change only the interpreter.

Keep byte-identical: the `pnpm harness:device --apk "$APK"` command (27a's driver, must run FIRST and
unmasked), the `adb install -r "$APK"`, and `maestro test --test-output-dir=maestro-artifacts .maestro/`.
The `upload Maestro artifacts` step and its `if: always()` stay as they are.

A repo-file script is also strictly better than inline YAML: it is lintable, shellcheck-able, and
runnable locally.

## FALSIFY (§2.11 — REPORT it, do not assert it)
The honest constraint: **this gate can only be falsified on the runner**, because the bug IS the
interpreter difference. So:
1. **Reproduce the failure locally first** — `/usr/bin/sh -c 'set -euo pipefail'` (or `dash -c …`)
   and paste the actual `Illegal option -o pipefail`. That proves the diagnosis rather than assuming it.
2. **Prove the new script keeps the fail-safe:** run `bash scripts/emulator-gates.sh` locally with a
   stubbed `pnpm harness:device` that exits non-zero, and confirm the script exits non-zero. Then make
   the stub exit 0 but put a failing command mid-pipe, and confirm `pipefail` still catches it. Restore.
3. **Then dispatch the real lane** and read the job log — not the step conclusion alone — to confirm
   `pnpm harness:device` actually produced output. A step that goes green having run nothing is the
   failure mode this whole task exists to document.
4. State plainly in your report which of the three you actually did.

## Note for whoever picks up 27a/117 after this
When the gates first truly run, expect real failures — nothing in `pnpm harness:device` or the Maestro
flows has ever been executed against a real AVD. A first red is the expected outcome and is progress,
not a regression.
