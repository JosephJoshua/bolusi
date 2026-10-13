# TASK 218 — local secrets scan catches ignored generated worktree artifacts

**Priority:** MEDIUM — local security gate currently fails; first classify any potential secret before modifying its scope.
**Depends on:** —
**Docs to read:** `security-guide.md` secret-scanning checklist; `08-stack-and-repo.md` CI conventions.
**Skills:** `implement-task`, `review-wave`, `qa-sweep`.
**Files / modules:** `scripts/secrets-scan.mjs`, its tests/config; generated worktree/build artifact handling if required.
**Filed by:** 2026-10-13 v0 review, local `pnpm sec:secrets` exit and redacted scanner report.

## Reproducing failure

`pnpm sec:secrets` ends `EXIT=1` with three `generic-api-key` matches in ignored release-bundle and sourcemap artifacts under `.claude/worktrees/task-144-item4-5-chip-a11y-visual/apps/mobile/android/app/build/`. `gitleaks git . --no-banner --redact=100 --exit-code 1` scanned 1,246 commits and returned `EXIT=0`. This is **not** proof the bundle contents are safe or that a key is real: classify the underlying string privately before calling it a false positive or excluding it.

## Acceptance / falsification

- Determine whether the bundle contains an actual sensitive credential and remediate the source/exposure if it does. Never print unredacted matches in logs.
- Preserve detection of known planted secrets in tracked source and relevant untracked code while avoiding duplicate/generated worktree build-output matches after classification; demonstrate the negative control goes red. CI and local scans should have an explicit, consistent scope.

## Classification / implementation (2026-10-13)

Read-only inspection of the original three artifacts with findings never printed: both release-bundle hits are identical scanner matches across duplicate **binary** Hermes bundles (NUL/invalid UTF-8 present); the matched bytes concatenate unrelated string-table fragments after an SQL query, not a standalone credential. The sourcemap hit is an identifier in the bundled `react-native-quick-crypto` PBKDF2 helper's source content, not a key. The generated sourcemap does not contain the bundle hit. The shared default-rule gitleaks config excludes only the generated Android app `build/` output; source (including native module Kotlin and relevant untracked files) and git history stay scanned. The repo scanner now requests full redaction for both scan legs.
