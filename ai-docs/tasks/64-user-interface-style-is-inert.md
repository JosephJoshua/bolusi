# TASK 64 — `userInterfaceStyle: 'light'` is a well-typed no-op: the prebuild pipeline says so out loud and nothing reads it

**Status:** todo
**Priority:** LOW — cosmetic, not a security surface. Filed for the **class**, not the blast radius.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none

## The finding

`apps/mobile/app.config.ts:11` sets `userInterfaceStyle: 'light'`. `expo-system-ui` is **not a dependency** of `apps/mobile` (nor in `pnpm-workspace.yaml`'s catalog). Running the real prebuild pipeline over the app's own config prints, verbatim:

```
» android: userInterfaceStyle: Install expo-system-ui in your project to enable this feature.
```

So the option is accepted, typechecks against `ExpoConfig`, reads as a deliberate product decision — and does nothing on the target platform. Expo's config docs are explicit that `userInterfaceStyle` requires `expo-system-ui` on Android.

## Why it is filed (T-12 — test the class, not the instance)

Found by task 58's class sweep, which asked the sibling question to review-05's: *what else in `apps/mobile` is a platform-conditional no-op that typechecks?* This is the same shape as task 58's `keychainAccessible` and task 59's `applyChannelImportance`:

- the symbol resolves, `tsc` is green, the value is well-formed;
- the field is dropped at runtime on the platform that ships;
- **no test, type, lint, or exit code can see it** — the only witness is a warning on a pipeline nobody runs in CI.

The difference worth noting: this one **announces itself**. The tooling prints the answer every prebuild, and it was still invisible for the life of the repo, because prebuild's stdout is not something anyone reads or gates on. A loud bug that nobody is listening to is a silent bug (T-15's "a loud bug masks silent ones", inverted).

## The decision this needs (do not guess it)

Two honest options — pick one, do not leave the third (status quo):

1. **Install `expo-system-ui`** and pin it SDK-57-aligned (`npx expo install expo-system-ui`), making the config line true. Costs a native dep for a cosmetic guarantee.
2. **Delete the line.** The app is light-only by design (`design-system.md`); if nothing depends on the system UI honouring it, the config should not claim it does.

Whichever lands, the option and the mechanism must agree — that agreement is the whole point.

## Worth considering while here

Task 58's harness (`apps/mobile/test/android-backup.test.ts`) already compiles the real prebuild pipeline in-process, offline, in ~1s. **The warnings it emits are a free signal this repo currently throws away.** A check that fails the build on unexpected prebuild warnings would have caught this on the day it landed, and would catch the next one by construction rather than by someone thinking to sweep. Scope that deliberately (an allowlist of known-benign warnings is required, or it will be red forever and then ignored — the failure mode CLAUDE.md §2.11 warns about).

## Docs to read

- `08-stack-and-repo.md` §2.2 (mobile native deps + pinning), `design-system.md` (is light-only a real product decision?).
- `apps/mobile/app.config.ts`, `apps/mobile/test/android-backup.test.ts` (the harness).
- CLAUDE.md §2.11; `testing-guide.md` T-12, T-15.

## Acceptance

- The config and the runtime agree: either `expo-system-ui` is installed and pinned, or the line is gone.
- Whatever lands is justified in one line against `design-system.md`, not asserted.
- The real prebuild pipeline no longer prints the `userInterfaceStyle` warning — **verified by reading the pipeline's own output** (§2.1), not by the absence of an error.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green.
