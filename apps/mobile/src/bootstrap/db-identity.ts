// The boot-time "is this database ours?" probe (security-guide §6.6; api/02-auth §7.4; task 160).
//
// ── THE BRICK THIS CLOSES (the SILENT successor to the SQLCipher one) ────────────────────────────
// Post-D22 (task 148) the client SQLite file is PLAINTEXT; only the 11 columns of 10-db §9.7 are
// AEAD-sealed, under the per-device SecureStore key. On an iOS restore-to-new-hardware `bolusi.db`
// restores but the THIS_DEVICE_ONLY key does not (security-guide §6.6). Boot mints a FRESH key,
// `open()` takes no key, so the restored file OPENS FINE — recovery.ts's old triggers (`missing_key`,
// `not_a_database`) never fire. Boot "succeeds", `readDeviceId` reads plaintext `meta_kv` and believes
// it is the old device, and every sealed read then surfaces OPAQUE ENVELOPE TEXT rendered as user
// data (since D22's keyed marker, a foreign-key value no longer throws — it passes through as
// `\x01gcm1:…` text; column-cipher.ts). A loud self-healing boot failure became a SILENT half-enrolled
// one. The trigger is iOS but the SAME thing happens on Android via a partial data-clear (the DB file
// survives while SecureStore is wiped), so this probe is gated on the CONDITION, never on `Platform.OS`.
//
// ── HOW IT DECIDES: A STORED KEY-TAG COMPARE, NEVER A DECRYPT-TO-SEE ─────────────────────────────
// The column cipher's marker (`Aes256GcmColumnCipher.marker`, exposed as `ClientDb.columnCipherMarker`)
// is a PURE FUNCTION OF THE DB KEY (deterministic, reopen-stable — the at-rest suite proves it) and a
// PUBLIC identifier (the same bytes already prefix every sealed cell). On the DB's FIRST boot this
// records the current marker in a known PLAINTEXT `meta_kv` cell (§9.7 lists `meta_kv.value` as
// plaintext by design). On every later boot it recomputes the marker from the CURRENT key and compares:
//
//   stored === current  → the file was sealed with the key we hold → OURS, boot on.
//   stored !== current  → the file was sealed with a DIFFERENT key (restore / partial-clear) → FOREIGN.
//   stored absent, deviceId null → a fresh/unenrolled DB with nothing sealed yet → BIND now, boot on.
//   stored absent, deviceId set  → an "enrolled" DB with no binding: impossible on any same-device
//                                  path (the marker is bound on first boot, long before enrolment), so
//                                  it is not trustworthy as ours → FOREIGN (defence in depth, below).
//
// This SEPARATES "cannot decrypt" from "could not read right now" cleanly, which the transient rule
// (recovery.ts) demands:
//   - The comparison itself is string equality — it NEVER throws. A FOREIGN verdict is therefore only
//     ever reached by a SUCCESSFUL read that returned a mismatching value.
//   - Any throw from the `meta_kv` read (a transient I/O error, a locked/partly-migrated file) is a
//     RAW driver error — NOT a `ForeignDatabaseError` — so `isUnrecoverableLocalDbError` returns false
//     and it SURFACES, un-wiped. A flaky read can never destroy a good database.
//
// ── WHAT IT MUST NEVER DO (SEC-DEV-06 — a §6 red flag to weaken) ────────────────────────────────
// It never opens the DB unencrypted, never derives or guesses a key, never "reads a sealed cell to
// see". A wrong-key DB stays opaque ciphertext; the ONLY recovery is destroy-and-re-enrol
// (recovery.ts's wipe). The marker is a public tag, so recording and comparing it discloses nothing
// that the sealed cells on disk did not already carry.
import { readMeta, writeMeta } from '@bolusi/core';
import type { Kysely } from 'kysely';

/**
 * `meta_kv` key holding this DB's column-cipher key tag (task 160). PLAINTEXT by design (§9.7 lists
 * `meta_kv.value` as plaintext — device ids/scalars; secrets live in SecureStore) and safe to store
 * in the clear because the marker is a public identifier already present on every sealed cell.
 */
export const DB_CIPHER_KEY_TAG_META_KEY = 'db.columnCipherKeyTag';

/**
 * The local DB opened successfully but was sealed with a key we do NOT hold — a restored foreign
 * database (or an Android partial data-clear that lost the key while keeping the file). It is
 * PERMANENTLY UNREADABLE WITH OUR KEY: the sealed columns stay opaque ciphertext and the only recovery
 * is destroy-and-re-enrol. Thrown by the probe on a DEFINITIVE marker mismatch ONLY, so
 * `isUnrecoverableLocalDbError` (recovery.ts) can route exactly this — and nothing a transient read
 * failure produces — into the existing wipe-and-re-enrol heal.
 */
export class ForeignDatabaseError extends Error {
  override readonly name = 'ForeignDatabaseError';
}

/**
 * Verify the open database was sealed with the key we hold, binding the tag on a fresh DB.
 *
 * Runs at boot AFTER migrations (so `meta_kv` exists) and reads only PLAINTEXT `meta_kv` — it never
 * touches a sealed cell, derives a key, or opens anything unencrypted (SEC-DEV-06). See the file
 * header for the four-way decision; a mismatch throws `ForeignDatabaseError`, everything else returns.
 *
 * @param db            the client Kysely handle (reads/writes plaintext `meta_kv`).
 * @param currentMarker `ClientDb.columnCipherMarker` — the marker of the key this boot opened with.
 * @param deviceId      the `meta_kv` device id already read this boot, or null when unenrolled.
 * @throws {ForeignDatabaseError} on a definitive "not sealed with our key" verdict. A READ failure is
 *   NOT caught here — it propagates raw, so the transient fail-safe surfaces it rather than wiping.
 */
export async function assertDatabaseKeyBinding<DB>(
  db: Kysely<DB>,
  currentMarker: string,
  deviceId: string | null,
): Promise<void> {
  // A throw from this read is a transient/structural failure, NOT a foreign DB — it propagates unwrapped
  // so recovery.ts surfaces it. Only a value that comes back is ever compared.
  const storedMarker = await readMeta(db, DB_CIPHER_KEY_TAG_META_KEY);

  if (storedMarker === currentMarker) return; // sealed with the key we hold — ours.

  if (storedMarker !== null) {
    // A tag is recorded and it is NOT ours: the file was sealed with a different key (restore /
    // partial data-clear). Unreadable with our key — hand it to the wipe-and-re-enrol heal.
    throw new ForeignDatabaseError(
      'the local database was sealed with a different key (restored foreign database) — it cannot be decrypted with this device’s key',
    );
  }

  // No tag recorded. Defence in depth: an "enrolled" DB (a persisted deviceId) with no binding cannot
  // arise on any same-device path — the tag is bound on the DB's first boot, long before enrolment — so
  // adopting it would re-create the exact silent half-enrolled bug (bind our new key's tag over someone
  // else's ciphertext and boot as them). Treat it as foreign rather than bind over it.
  if (deviceId !== null) {
    throw new ForeignDatabaseError(
      'the local database has an enrolled device id but no cipher key tag — refusing to adopt an unbound database',
    );
  }

  // A genuinely fresh/unenrolled DB (or a same-device first run interrupted before the tag was bound —
  // the key persists in SecureStore, so recording the current tag is correct): BIND the tag now. A
  // throw from this write is again a transient/structural failure that surfaces, never a foreign verdict.
  await writeMeta(db, DB_CIPHER_KEY_TAG_META_KEY, currentMarker);
}
