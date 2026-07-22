# TASK 160 — the boot self-heal can no longer fire for the case it exists for: a restored plaintext DB now opens successfully, so the app boots into a SILENT half-enrolled state

**Status:** todo
**Priority:** **HIGH** — a failure that used to be loud at boot and self-healed is now silent and strictly worse. Surfaced by the task-148 review (F2), confirmed by the implementer, deliberately NOT fixed in 148 because the hard part is semantics, not code.
**Depends on:** 148 (which created the condition by removing SQLCipher)
**Blocks:** —
**SEC ids owned by THIS task:** none new — but it degrades the recovery leg `security-guide §6.6` describes, so reconcile that row.
**Filed by:** the task-148 reviewer (F2) + implementer concurrence, 2026-07-22.

## The finding
`apps/mobile/src/bootstrap/recovery.ts` heals only on `missing_key` or a `driver_open_failed` classified `not_a_database`. **Post-148 the iOS restore-to-new-hardware path produces neither:**
- `ensureDatabaseEncryptionKey()` mints a fresh key → never `missing_key`.
- `open()` takes no key any more, so the restored **plaintext** SQLite file **opens fine** → never `not_a_database`.

Proof from 148's own suite: `at-rest-column-encryption.test.ts` `reopen(file, dir, WRONG_KEY)` **resolves**; the throw only arrives on the subsequent SELECT.

**Net effect:** the app boots "successfully" into a half-enrolled state — `readDeviceId` reads plaintext `meta_kv`, so it believes it is the old device — and then throws AEAD errors deep in the UI. Under SQLCipher this was a loud boot failure that self-healed. It is now a silent one.

## Deliverable
A boot-time **"can we decrypt a known cell?" probe** that classifies an undecryptable-but-openable DB as the same recoverable condition the SQLCipher path used to produce, and routes it to the existing self-heal.

**The hard part is semantics, not code — decide and TEST each:**
- an **empty** DB (fresh install: nothing to probe — must not wipe);
- a **partially-written** DB (interrupted first-run);
- a **transient I/O failure** during the probe — the existing rule is that a transient must **NEVER** reach the wipe, so the probe must distinguish "cannot decrypt" from "could not read right now";
- which cell is the canonical probe target (it must exist on every enrolled device and be one of the 11 encrypted columns).

## FALSIFY (§2.11 — REPORT it)
- Reproduce the silent path first: restore a plaintext DB alongside a freshly-minted key → the app boots, `readDeviceId` returns the old device, and the first encrypted read throws in the UI. Lead with that.
- After the fix: the same input is classified at boot and self-heals (or fails loudly), never a half-enrolled boot.
- **Positive controls (all three mandatory):** a fresh empty DB boots normally and is NOT wiped; a healthy enrolled DB boots normally; a simulated transient read error does NOT trigger the wipe.
- Reconcile `recovery.ts`'s header and `security-guide §6.6` (148 marked the SQLCipher paragraph as history; this task makes the replacement true).
