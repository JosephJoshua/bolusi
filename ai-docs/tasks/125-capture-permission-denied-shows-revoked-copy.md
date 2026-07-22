# TASK 125 — declining the camera permission tells the user their DEVICE IS REVOKED: `CaptureScreen` renders `auth.revoked.body` for `permission_denied`

**Status:** done
**Priority:** **HIGH — actively misleading, security-adjacent copy.** A technician who taps "Deny" on the OS camera prompt is told the device is blocked and to contact the shop owner to re-enroll. That is a false revocation signal on a product whose revocation flow is a real security control (api/02-auth §7.3) — it will generate support calls and may trigger an unnecessary re-enrollment.
**Depends on:** 82 (media capture)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA visual state-map sweep, 2026-07-22.

## The finding (verified)

`apps/mobile/src/media/CaptureScreen.tsx`:
```
case 'permission_denied':
    title={t('media.permission.camera')}
    hint={t('auth.revoked.body')}     // <-- the DEVICE-REVOKED copy
```
Rendered (`artifacts/capture-unauthorized.png`, both locales): title "Izinkan aplikasi memakai kamera untuk ambil foto." over body "Perangkat ini sudah diblokir dan tidak bisa dipakai lagi. Hubungi pemilik toko untuk …" — two contradictory messages on one screen. `design-system.md` §5 requires the unauthorized body be permission guidance.

**The comment-was-the-guard class again:** the same file's header (lines 30-32) states *"The hint is `media.permission.camera`, the same sentence the OS dialog shows, so the two do not contradict each other"* — and line 234, ~200 lines below, does exactly the opposite. An accurate, spec-citing comment sitting above code that violates it (CLAUDE.md §2.11, T-15).

## Deliverable
- Render permission guidance for `permission_denied` (the `media.permission.*` copy the header already names), and keep `auth.revoked.*` for the actual revoked state. Check whether the revoked state is separately reachable on this screen and correct.
- **Falsify:** assert the rendered hint for `permission_denied` is the permission copy and NOT the revoked copy; swap it back → RED → restore → green. Also confirm the header comment now matches the code (or fix the comment) — a stale authoritative comment is the defect's other half.
- Regenerate the 116 screenshots; `capture-unauthorized.png` must no longer mention blocking/re-enrollment.
