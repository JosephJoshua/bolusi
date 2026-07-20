# D19 — The device `appVersion` source (2026-07-20)

**Date:** 2026-07-20 · **Status:** Proposed — needs an owner/§6 ruling. Filed by task 94; the code ships the honest interim (`''`) and does NOT pin a dependency unilaterally.

## The situation

Two places report the app's version, and both send `''` today:

1. **The enroll POST** (`apps/mobile/index.ts createEnrollment`) — `EnrollRequest.appVersion`, so the server's device-management UI shows a version per device.
2. **The Settings device block** (task 94) — the `appVersion` line under `platform`.

Both are wired from ONE source, `index.ts`'s `APP_VERSION` const, so they can never disagree. It is `''` because **`expo-constants` is not pinned in `08 §2.2`**, and reading `Constants.expoConfig?.version` requires both pinning the dependency and setting the version in the Expo app config. `''` is VALID per the server's `EnrollReq` (`z.string().max(32)`), so it is inert — not broken. It was deliberately not faked with a plausible-but-wrong version (T-19): a wrong version on a revocation screen is worse than an empty one.

## The decision needed

Pick one:

- **(A) Pin `expo-constants` → real `appVersion`.** Add `expo-constants` to `08 §2.2` (latest stable, lockfile-pinned), set the version in the Expo config, and source `APP_VERSION` from `Constants.expoConfig?.version ?? ''`. This is a **spec-table change** (`08 §2.2`) and a **new dependency** — a CLAUDE.md §4/§6 stop-and-ask, which is why task 94 did not do it. Its own follow-up task.
- **(B) Ratify `''` as v0-acceptable** and record it in `api/02-auth §4.3` (enroll request) + the Settings spec, so the empty version is a documented v0 limitation rather than an untracked gap.

## Recommendation

**(B) for v0, (A) as a v1 follow-up.** The device-management UI keys revocation on the **deviceId** (exact, always present); the app version is an operational nicety, not an identity field. Shipping `''` unblocks task 94's real fix (device name / store / tenant now render) without dragging a dependency-pin decision into a MEDIUM cosmetic task. When (A) lands, `APP_VERSION` is the single line that changes, and both the POST and the Settings row pick it up.
