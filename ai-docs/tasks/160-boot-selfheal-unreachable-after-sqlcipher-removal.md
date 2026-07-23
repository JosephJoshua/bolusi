# TASK 160 — the boot self-heal can no longer fire for the case it exists for: a restored plaintext DB now opens successfully, so the app boots into a SILENT half-enrolled state

**Status:** todo
**Priority:** **HIGH** — a failure that used to be loud at boot and self-healed is now silent and strictly worse. Surfaced by the task-148 review (F2), confirmed by the implementer, deliberately NOT fixed in 148 because the hard part is semantics, not code.
**Depends on:** 148 (which created the condition by removing SQLCipher)
**Blocks:** **27a** — named blocker, see "Why this blocks 27a" below.
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


---

## RAISED IN IMPORTANCE 2026-07-22 by task 148 round 3 (the keyed marker)

148's keyed marker makes the marker unforgeable by deriving it from the DB key. A necessary consequence: values sealed under a **different** key no longer match the marker, so a foreign-key DB's rows now surface as **opaque envelope text instead of throwing**. The security property is intact (no plaintext; `decrypt` still throws; `isCiphertext` false) — but it removes the last incidental place a restored foreign DB announced itself.

**So this task is now MORE load-bearing, not less:** a stored key-tag comparison at open is the ONLY remaining place a restored foreign DB gets caught. Before the keyed marker, a wrong-key read at least threw; now it can return sealed text that a caller may treat as data. Design the probe accordingly — it is no longer a nice-to-have boot check, it is the detection mechanism.

---

## REPRODUCTION (task-148 review, round 3) — traced AND executed, not reasoned

Wrote `users_directory` rows under key A, closed, reopened the same file under key B, and called the **real** `listSwitcherUsers`:

```
listSwitcherUsers → [{ id: 'user-1', name: 'gcm1:bk3aiowMaKSZ:SO95nBRnd7…' }]   (71 chars, NO throw)
```

Since D22's keyed marker, values sealed under a different key no longer match the reader's marker, so they are passed through as **opaque envelope text** rather than throwing. The render path swallows it silently:

- `SwitcherScreen.tsx:172` `{user.name}` — the sign-in screen renders the envelope string as a person's name; also `:165` `accessibilityLabel` and `:170` `initialsOf`.
- `NotesList.tsx:173`/`:213` and `NoteDetail.tsx:187`/`:196` — same for note titles/bodies.

**The only thing that throws is an accident, not a check:** `readVerifier` fails at `packages/core/src/projection/columns.ts:72` because `params` happens to be JSON and `JSON.parse` rejects the envelope; it is caught at `session.ts:246-250`. That is one column's data type, not a shape check — it does nothing for `salt`/`hash` alone, nothing for a user with no verifier row (§6.6 first-PIN), and nothing at all for notes.

So the honest statement of this task's severity: **not "opaque text in one place" but "the app renders ciphertext as user data across the switcher and every notes surface, with no error anywhere."**

## Why this blocks 27a (re-filed 2026-07-22)

This was first filed as a follow-up. It is re-filed as a **named blocker on task 27a**, on the reasoning the 148 reviewer proposed and the orchestrator accepted:

- It must NOT block `main`. Blocking on 160 deadlocks: 160 is far easier to build and falsify *with* 148 landed, and — decisively — **no client DB has ever existed on any device**, so the restore path is unreachable today. There is nothing to restore from.
- It MUST block **27a**. The emulator lane is the first moment a database exists on real hardware that can later be restored, and 27a is where **SEC-DEV-06 gets claimed**. Claiming "the sensitive columns are ciphertext at rest" on a device whose boot cannot tell a foreign database from its own would be claiming the control while its recovery leg is missing.

**The fix, for whoever takes it:** a boot-time probe that decides "is this database ours?" against a stored key tag (the cipher already derives one — `Aes256GcmColumnCipher.marker`), rather than waiting for a read to fail. The hard part is semantics, not code: what to do on an EMPTY database, on a partially-written one, and on a transient I/O failure — and `recovery.ts`'s existing rule that a transient must **never** reach the wipe still binds.
