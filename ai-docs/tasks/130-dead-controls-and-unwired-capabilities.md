# TASK 130 — five shipping controls are wired to `noop`, and two built capabilities have no production consumer

**Status:** todo
**Priority:** MEDIUM — controls that render, respond to touch, and do nothing. The "sound tests, zero callers" class (CLAUDE.md §2.11); component tests inject `vi.fn()` and assert the callback fires, so they can never see what the composition root actually passes.
**Depends on:** 82, 96, 119, 24
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA spec-verify sweep, 2026-07-22 (items D6/D7/D11).

## The finding

**Wired to `noop` in the shipping app** (`apps/mobile/App.tsx:220-221, 258-259`, noop at `:328`):
- `onRetryMedia` — 06 §5.2(e) requires "manual retry from the sync-status screen". `MediaClient.requestManual()` has **zero** production callers (contrast `SyncClient.requestManual()`, wired at `Root.tsx:431`).
- `onOpenRejected` — 06 §8 / 05 §2.3: rejections "must be surfaced, never silent"; every `failed` item visible with its `lastErrorCode`.
- `onEnroll`, `onRetry` on SwitcherScreen — and `SwitcherScreen.tsx:87,97` wires `onRetry` to BOTH the §5 Error retry and the Unauthorized back, so both dead-end (design-system §5 MUST-NOT).

**Built but unconsumed:**
- `MediaClient.storageBand()` (`media/client.ts:314`) — 06 §7's `< 500 MB` Warning / `< 200 MB` Loud banners. Computed, exposed, read by nobody in the native app; the only `StorageBand` consumer outside `media/*` is `CaptureScreen`, itself reachable only from the web gallery. **06 §7's storage banners have never rendered.**
- The in-app camera has no shipping entry point (`bootstrap/notes.ts:71-73,96` — `capturePhoto` stays `UNWIRED_NOTES_MEDIA` and rejects). 06 §2.1 says "the shared `MediaCapture` component is the only capture surface". Honestly documented in code, but **no task in `_index.md` owns the wiring** (18 and 82 are both `done`) — so it is nobody's.

## Deliverable
- Wire the five controls to their real producers, or remove the affordance (a control that cannot work must not render — §5 MUST-NOT). Decide per control and say which.
- Wire the storage bands to the capture surface per 06 §7, and give the in-app camera entry point an owner (this task, or a filed successor — do not leave it unowned again).
- **Falsify (the point):** a COMPOSED test that presses each control on the real `App`/`Root` tree and observes the real producer run (e.g. media retry → `requestManual()` called). Re-point one to `noop` → RED → restore. A component test injecting `vi.fn()` proves nothing here — that is exactly what let these ship.
