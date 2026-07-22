# TASK 126 — the Sync Status screen is titled "Rejected Changes" in EVERY state, including all-clear

**Status:** todo
**Priority:** **HIGH — a healthy device reports a problem.** A shop owner opening the sync screen on a fully-synced device sees the header "Perubahan Ditolak" (Rejected Changes) above the body "Semua perubahan terkirim" (everything sent). On a product whose trust model depends on the sync chip and this screen being believable (design-system §3.5/§8.4), a false alarm in the title is corrosive.
**Depends on:** 24, 15 (sync)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA visual state-map sweep, 2026-07-22.

## The finding (verified)

`apps/mobile/src/screens/sync-status/SyncStatusScreen.tsx:90` hardcodes `title={t('sync.rejected.title')}` for the whole screen, in every state. `design-system.md` §8.4 names this the **Sync Status** screen. Line 194 reuses the same key as a section header, so in the `attention` state the phrase appears twice, plus a third time in the banner.

Rendered proof: `artifacts/sync-status-allSent.png` — header "Perubahan Ditolak", body "Semua perubahan terkirim".

## Deliverable
- Title the screen per §8.4 (a Sync Status title; add the catalog key if `core`/`sync` lacks one — do not reuse `sync.rejected.title`), and keep `sync.rejected.title` for the rejected SECTION only.
- **Falsify:** assert the all-clear state's title is NOT the rejected string; revert → RED → restore → green.
- Regenerate the 116 screenshots and check every `sync-status-*` state's header reads correctly.

## Note
Related, filed separately as part of the §8.4 conformance batch (task 128): the rejected rows omit the op-type label and rejection code §8.4 requires, so a user calling support has nothing to quote.
