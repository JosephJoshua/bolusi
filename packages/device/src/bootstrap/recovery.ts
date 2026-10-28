// The boot-time self-heal for an UNREADABLE local database (security-guide §6.6; api/02-auth §7.4).
//
// ── THE BRICK THIS CLOSES (post-D22 — the SQLCipher mechanism is HISTORY, see below) ────────────
// On an iOS restore-to-new-hardware the `bolusi.db` file DOES restore (it cannot be excluded at the
// build-artifact level — security-guide §6.6, Apple's own docs) while the DB key does NOT
// (`ports/db-keystore.ts` sets `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so the Keychain item never migrates
// to new hardware — the §7.4 "never resurrected" property working as intended). `bootstrap()` then
// MINTS A FRESH key.
//
// Since D22 the file is PLAINTEXT and `open()` takes no key (task 148), so the restored old-key file
// OPENS SUCCESSFULLY — the loud SQLCipher `not_a_database` rejection that this module was first built
// to catch CAN NO LONGER FIRE. What now distinguishes a restored foreign DB from our own is that its
// 11 sealed columns (10-db §9.7) carry a DIFFERENT key's marker: `bootstrap()`'s key-tag probe
// (`db-identity.ts`, task 160) compares the on-disk tag against the current key's and throws
// `ForeignDatabaseError` on a mismatch. That is the LIVE trigger this module heals today. Before any
// self-heal existed the failure reached `Root.tsx`'s DELIBERATE no-catch, `setApp` never ran, and the
// app rendered NOTHING (SQLCipher era) or booted SILENTLY into a half-enrolled state that rendered
// ciphertext as user data (the post-D22 successor, strictly worse — task 160). Both end here now.
//
// A restored device is NOT a corrupt device: it is a FRESH device wearing an old device's ciphertext.
// The correct response is api/02-auth §7.4's re-enrolment path reached by a different trigger — WIPE
// the unreadable DB + its key and drop to enrollment — exactly as a factory-reset Android already
// does (task 58 excludes the DB from Android backup, so a restored Android device has no file and
// re-enrols cleanly; iOS is exposed precisely because its backup restores the DB).
//
// ── PLATFORM-NEUTRAL BY CONSTRUCTION ──────────────────────────────────────────────────────────
// The trigger is iOS but the defence is not iOS-special-cased: the same key/file mismatch can occur
// on Android too (a partial app-data clear that loses SecureStore while keeping the DB, an OS bug).
// The heal is gated on the ERROR, never on `Platform.OS`.
//
// ── WHAT THIS MODULE MUST NEVER DO (SEC-DEV-06 — a §6 red flag to weaken) ──────────────────────
// It never opens the DB unencrypted, never derives a key, never "reads it to see". A wrong-key DB
// stays unreadable ciphertext; the ONLY recovery is destroy-and-re-enrol (the server re-provisions
// on a fresh enrol — offline-first, unsynced local work on the bricked DB is unrecoverable BY
// DEFINITION, which is the restore reality this heals into, not away from). The wipe is INJECTED
// because both its legs are native (SecureStore key erase + the op-sqlite file delete live at their
// binding sites — apps/mobile/index.ts).
import { DbOpenError, classifyDbError } from '@bolusi/db-client';

import type { Bootstrapped } from './bootstrap.js';
import { ForeignDatabaseError } from './db-identity.js';

export interface LocalDbRecoveryDeps {
  /** The raw data-layer boot (`bootstrap()`). Called at most twice: once, then once after a wipe. */
  readonly boot: () => Promise<Bootstrapped>;
  /**
   * Crypto-erase the local data layer: delete the SQLCipher key (api/02-auth §7.3 step 1 — the DB is
   * unreadable ciphertext from this moment) THEN delete the DB file(s) + WAL/SHM (step 2). After it
   * resolves, a re-boot mints a fresh key and creates a fresh EMPTY DB — the honest unenrolled state
   * (`deviceId: null`). Injected: both legs are native and cannot load under Node.
   */
  readonly wipeLocalData: () => Promise<void>;
}

/**
 * True IFF `error` means THE LOCAL DB IS PERMANENTLY UNREADABLE WITH OUR KEY — the restore/orphan
 * class a wipe-and-re-enrol heals — and NOT a transient or structural failure a wipe would turn into
 * destruction of a good database.
 *
 * HEAL (return true):
 *   - `ForeignDatabaseError` — the LIVE post-D22 restore trigger (task 160). The file opened but its
 *     sealed columns carry a DIFFERENT key's marker; `bootstrap()`'s key-tag probe (`db-identity.ts`)
 *     threw this on a definitive mismatch. It is unreadable with our key → destroy-and-re-enrol. This
 *     is now the ONLY place a restored foreign DB is caught, since the file opens without a key.
 *   - `missing_key` — the key store has nothing; the DB (if present) is unreadable ciphertext, so
 *     the same destroy-and-re-enrol applies. (In the restore path `bootstrap()` mints a key before
 *     opening, so the live symptom is `ForeignDatabaseError`; this covers a key that vanished on its own.)
 *   - `driver_open_failed` classified `not_a_database` — SQLCipher's wrong-key symptom. HISTORY since
 *     D22 (`open()` takes no key, so a restored file opens plaintext rather than being rejected), kept
 *     as a defensive branch for a genuinely corrupt header. `classifyDbError` matches SQLite's own
 *     "file is not a database" / "file is encrypted or is not a database" text, which `connection.ts`'s
 *     `sanitizeOpenFailure` carries verbatim into BOTH the `DbOpenError` message and its `cause`.
 *
 * SURFACE (return false — `Root.tsx`'s no-catch keeps failing loudly, which is correct for these):
 *   - `driver_open_failed` that is an I/O / disk error (classifies `unknown`) — a TRANSIENT or
 *     hardware failure. Wiping a good-but-momentarily-unopenable DB is worse than the brick (task
 *     acceptance + §2.5-adjacent data safety), so a transient must never reach the wipe.
 *   - A THROW FROM THE KEY-TAG PROBE'S READ — a transient `meta_kv` read failure is a raw driver
 *     error, NOT a `ForeignDatabaseError`, so it lands here and surfaces. The probe reaches a foreign
 *     verdict only via a SUCCESSFUL read that returned a mismatching tag: "cannot decrypt" and "could
 *     not read right now" are different answers and only the first wipes (db-identity.ts).
 *   - `already_open` / `not_open` — one-connection / lifecycle bugs, not an unreadable file.
 *   - anything else (a migration / registration / keystore throw) — unrelated to key-vs-ciphertext;
 *     a wipe would destroy a DB that opened fine.
 */
export function isUnrecoverableLocalDbError(error: unknown): boolean {
  // The LIVE post-D22 restore/partial-clear trigger: the file opened but was sealed with a key we do
  // not hold (task 160). This is checked first because it is the one that actually fires now.
  if (error instanceof ForeignDatabaseError) return true;
  if (!(error instanceof DbOpenError)) return false;
  if (error.code === 'missing_key') return true;
  // `driver_open_failed` deliberately covers BOTH wrong-key (heal) AND I/O/corruption (surface), so
  // the code alone cannot decide — sub-classify on SQLite's own message text.
  if (error.code !== 'driver_open_failed') return false;
  if (classifyDbError(error) === 'not_a_database') return true;
  return causeIsNotADatabase(error);
}

/** The native error may carry the "file is not a database" text on the cause rather than the top
 * message; `sanitizeOpenFailure` puts it on both, but classify the cause too so a future re-wrap
 * that moved it cannot silently downgrade a wrong-key open to "surface". */
function causeIsNotADatabase(error: DbOpenError): boolean {
  const cause: unknown = error.cause;
  return cause !== undefined && cause !== null && classifyDbError(cause) === 'not_a_database';
}

/**
 * Boot the data layer, self-healing a restored/orphaned (wrong-key) DB.
 *
 * On the unrecoverable class ONLY: wipe once, then re-boot into a fresh empty DB (`deviceId: null` →
 * the enrollment wizard, reached through the EXISTING gate — no new screen; a fresh enrol
 * re-provisions from the server). At MOST one retry: if the boot over a freshly-wiped DB still
 * fails, that is a genuine failure and it SURFACES (rethrows) rather than looping — a wipe that
 * could not produce a bootable DB must not run forever (task acceptance: "do not loop"). A transient
 * or unrelated failure surfaces IMMEDIATELY, un-wiped — the fail-safe that keeps a flaky open from
 * destroying a healthy DB.
 */
export async function bootWithLocalRecovery(deps: LocalDbRecoveryDeps): Promise<Bootstrapped> {
  try {
    return await deps.boot();
  } catch (error) {
    if (!isUnrecoverableLocalDbError(error)) throw error;
    await deps.wipeLocalData();
    return await deps.boot();
  }
}
