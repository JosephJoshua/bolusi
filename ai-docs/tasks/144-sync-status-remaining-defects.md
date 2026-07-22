# TASK 144 — the rest of the Sync Status screen: a green-guarded decoy, the same hardcode task 126 fixed still live on a second field, and a screen-reader label that never changes

**Status:** todo
**Priority:** MEDIUM — one live §2.11 decoy (a model value with zero callers, guarded by a sound test), one latent instance of task 126's exact bug, and two conformance defects. Filed by the task-126 implementer, who correctly refused to fold them in.
**Depends on:** 126, 15
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-126 implementer, 2026-07-22.

## Items

1. **`sync-disabled-reason` is a live decoy.** `SyncStatusScreen` hardcodes `translateRejectionCode('DEVICE_REVOKED')`, while `model.ts:283` computes `reasonKey: 'core.rejection.DEVICE_REVOKED'` and `model.test.ts:321` **asserts that computed value**. `grep reasonKey SyncStatusScreen.tsx` → nothing. The model produces a value with **zero callers** and a sound test guards it: break the screen's string and nothing reds. Wiring it means narrowing `ManualSync.reasonKey` from `string` to the generated key union — a type change, which is why 126 left it.
2. **`sync-manual-error` is task 126's bug, still live.** The screen renders `t('core.errors.NETWORK')` for **any** `manualSyncError`. Latent only because every producer currently passes `null` (`bootstrap/shell-inputs.ts:47`, `web/seed.ts:130`) — the moment one doesn't, every failure claims a network problem. **Decide the semantics first:** `model.test.ts:336` treats the field as a full **key** (`'core.errors.NETWORK'`) while `translateErrorCode` expects a bare **code**; they disagree today. Also design-system §5's Error state requires the code be shown for support, and this branch shows none.
3. **The `attention` reassurance line duplicates the banner verbatim.** `REASSURANCE_KEY.attention = 'sync.rejected.banner'`, so the screen shows "1 perubahan ditolak server. Ketuk untuk melihat." **twice**, ~40 px apart — and the second copy tells the user to tap to view the screen they are already on.
4. **`SyncChip`'s `accessibilityLabel` is state-invariant** — always `sync.status.lastSynced`, so a screen-reader user hears "Terakhir terhubung 4 menit lalu" whether the chip reads `synced` or `attention`. design-system §6.3/§6.4. Likely a `packages/ui` change (contended — serialize).
5. **The `syncing` state has never been screenshotted.** `e2e-web/visual.spec.ts:64-68`'s matrix has no `sync-status/syncing` row, so the fifth state's rendering has never been seen. 126 added render-test coverage but left the matrix alone (adding a row changes the screenshot count other docs cite — update those in the same change).

## FALSIFY (§2.11 — REPORT it)
For item 1, the acceptance is that breaking the SCREEN reds a test — that is precisely what does not happen today. For item 2, a positive control is mandatory: a non-network failure must resolve a different key than a network one, or the fix is untestable by construction.
