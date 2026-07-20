# TASK 94 — an enrolled device shows blank metadata (Settings + the enroll `appVersion`)

**Status:** in-progress
**Priority:** MEDIUM — cosmetic-to-operational, but newly VISIBLE now that task 92 made enrollment work: a real enrolled device reaches the Settings screen with every device field blank.
**Depends on:** 24, 92
**Blocks:** —

## The finding (task 92, 2026-07-17)

Two ends of the same gap — the device knows who it is, and neither end says so:

1. **Settings shows nothing.** `apps/mobile/index.ts`'s `Bootstrapped()` hands `Root` a HARDCODED
   `deviceInfo: { deviceId: '', deviceName: '', storeName: '', tenantName: '', platform, appVersion: '' }`.
   It flows `Root → App → SettingsScreen device={props.deviceInfo}` unchanged. Before task 92 no device
   was enrollable, so this was invisible. Now an enrolled device renders the Settings screen with a
   blank device name, store, and tenant — every field the owner would revoke a device by. The values
   all EXIST post-enrollment: `deviceId`/`storeId` in `meta_kv` (task 88), the store/tenant **names** in
   the directory tables + the enroll response, and `deviceName` is what the owner typed in the wizard.
   `index.ts`'s own header already flags this as owed ("The bootstrap (task 24 item 2) hands the
   persisted values in") — it was never wired. The fix is to derive `deviceInfo` from the booted app's
   persisted state (a `meta_kv` + directory read) rather than a literal, on `Bootstrapped` or in `Root`.

2. **The enroll POST sends `appVersion: ''`.** `createEnrollment` (index.ts) sets `appVersion: ''`
   because `expo-constants` is not pinned in `08 §2.2` and adding it is a spec-table change (§4/§6).
   Empty is VALID per the server's `EnrollReq` (`z.string().max(32)`), so it is inert, not broken — but
   the server's device-management UI then has no app version for the device. Deliberately not faked with
   a plausible-but-wrong version (T-19). Pinning `expo-constants` + reading `Constants.expoConfig?.version`
   is the fix, and it is the same `expo-constants` decision `index.ts`'s deviceInfo header already defers.

## Acceptance

- The Settings screen of an enrolled device renders its real device name, store name and tenant name,
  read from persisted state — never a literal, never a `?? ''`.
- A decision on `expo-constants` (pin it → real `appVersion`, or ratify `''` as v0-acceptable in the spec).
- A test mounts Settings over a booted+enrolled app and asserts the fields are the persisted values (the
  `apps/mobile` render lane exists but is unused — task 69).
