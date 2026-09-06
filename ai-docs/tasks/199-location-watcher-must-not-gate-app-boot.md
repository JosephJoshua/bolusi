# TASK 199 — the background location watcher must not gate the app shell: a wedged/absent location provider hangs boot forever (found on the 27a emulator lane)

**Depends on:** —
**Blocks:** 198's "genuinely green" emulator-lane merge (they share the one `android-emulator` job conclusion), 117 (the `01-launch-enrollment` Maestro flow that surfaced it)
**SEC ids owned by THIS task:** none.
**Priority:** HIGH — a first-boot hang with no recovery on a class of real devices.
**Filed by:** the task-198 step-4 emulator run 2026-09-06 (root-cause per systematic-debugging on on-device evidence).

## The finding (root cause, confirmed on-device)

`apps/mobile/src/bootstrap/Root.tsx:447` boots with the background location watcher on the **awaited** critical path:

```
await createNotificationChannels(defaultMuteState());  // 446
await startLocationWatcher();                          // 447  <-- gates everything below
const booting = await boot();                          // 465  <-- DB open — NEVER REACHED if 447 hangs
// ... setApp(booting) / setDeviceInfo(...) — the shell only mounts after these
```

`Root` returns `null` until `locale && app && deviceInfo` resolve. So if `startLocationWatcher()` never settles, `boot()` never runs, `setApp` never fires, and **the shell never renders** — a permanent white screen, no error, no retry.

`startLocationWatcher()` (`apps/mobile/src/ports/location.ts:40-50`) awaits two native expo-location calls: `requestForegroundPermissionsAsync()` then `watchPositionAsync({ accuracy: Balanced, ... })`. On the AOSP emulator image (API 34 `default`, **no Google Play Services**) the balanced-accuracy watcher resolves through the Google fused location provider, which returns `SERVICE_INVALID` and the awaited promise **never resolves** (`device-logcat.txt`: `GoogleApiManager … location.zzda … SERVICE_INVALID`; `Running "main"` then silence; `bolusi-app-shell is visible` assertion fails at 17s). React Native release swallows the unhandled state (LogBox is dev-only), so there is no crash to observe — just a hang.

This is **not** emulator-only. The same permanent-hang class reaches real hardware whenever the fused provider is unavailable or wedged: a device with Play Services disabled/absent (many low-end / de-Googled Android units — exactly Bolusi's target hardware), Location Services turned off, or a provider stuck mid-init. The location port's own contract already says location is **telemetry, never blocking** (`ports/location.ts:1-18`, "NON-BLOCKING by contract"; 04 §5.1 "null never blocks") — the port honours it, but the boot **caller** at Root.tsx:447 violates it by awaiting the watcher's *start*.

## Deliverable

Make the watcher start **fire-and-forget** so it can never gate the shell:

```js
// Root.tsx:447 — before
await startLocationWatcher();

// after (best-effort, cannot block boot)
void startLocationWatcher().catch(() => {});
// getBestFix() is already non-blocking by design (ports/location.ts); a fix that arrives late is
// stamped on the next op, and a fix that never arrives is `null`, which is a supported state.
```

Nothing after line 447 depends on the watcher: `getBestFix()` reads a module-level `lastFix` non-blocking on every op-append (05 §2.1), returning `null` until a fix lands. The ordering comment at Root.tsx:442-443 only requires i18n before notification channels; the watcher has no ordering constraint. The `.catch(() => {})` keeps a rejected permission/provider promise from surfacing as an unhandled rejection — a denied/off/wedged location is a supported state the user is never shown (PRD-009 FR-802), not an error.

## Acceptance / FALSIFY (§2.11)

A **render-boundary** test (mounts the REAL `Root`, [[bolusi-falsify-at-the-boundary]]) — a unit test of `location.ts` or of `Root` with an injected `boot` cannot see this wire, because the hang is in a *direct-import* call on the boot path, not an injected prop:

- **The reproduction (must render despite a wedged watcher):** mount `Root` with `expo-location` mocked so permission is **granted** and `watchPositionAsync` returns a never-resolving promise — the exact fused-provider `SERVICE_INVALID` shape. Assert `bolusi-app-shell` renders. Fails RED on the awaited line 447 (shell never mounts); passes GREEN once the call is fire-and-forget.
- **Falsification watched:** with the fix in place, revert line 447 to `await startLocationWatcher()` and confirm the new test goes RED (shell absent) — then restore and confirm GREEN. Report the break/observe/restore, never "the test passes" (§2.11).
- **No regression:** the existing `live-shell-*` suite (which mocks `requestForegroundPermissionsAsync` to `{ status: 'denied' }`, the fast-return branch) stays green — the fix does not change the denied path, only removes the boot-time `await`.

## Sequencing

Own branch off `origin/main`; lands **before** 198 merges. Then merge main into task/198, re-dispatch the ~22-min emulator lane, and confirm the `01-launch-enrollment` flow reaches the shell. No `ci.yml` change (owner-gated per task 194 / §6).
