// The boot-time self-heal for an UNREADABLE local database (security-guide §6.6; api/02-auth §7.4).
//
// ── THE BRICK THIS CLOSES ──────────────────────────────────────────────────────────────────────
// On an iOS restore-to-new-hardware the encrypted `bolusi.db` file DOES restore (it cannot be
// excluded at the build-artifact level — security-guide §6.6, Apple's own docs) while the SQLCipher
// key does NOT (`ports/db-keystore.ts` sets `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so the Keychain item
// never migrates to new hardware — the §7.4 "never resurrected" property working as intended).
// `bootstrap()` then MINTS A FRESH key, `openClientDb` opens the restored old-key file with it, and
// SQLCipher rejects it — `connection.ts`'s `sanitizeOpenFailure` wraps that as
// `DbOpenError('driver_open_failed', '…: file is not a database')`. Before this module that throw
// reached `Root.tsx`'s DELIBERATE no-catch (`const booting = await boot()`, no try/catch), `setApp`
// never ran, and `if (app === null) return null` rendered NOTHING, permanently, with no recovery.
//
// A restored device is NOT a corrupt device: it is a FRESH device wearing an old device's
// ciphertext. The correct response is api/02-auth §7.4's re-enrolment path reached by a different
// trigger — WIPE the unreadable DB + its key and drop to enrollment — exactly as a factory-reset
// Android already does (task 58 excludes the DB from Android backup, so a restored Android device
// has no file and re-enrols cleanly; iOS is exposed precisely because its backup restores the DB).
//
// ── PLATFORM-NEUTRAL BY CONSTRUCTION ──────────────────────────────────────────────────────────
// The trigger is iOS but the defence is not iOS-special-cased: the same wrong-key open can occur on
// Android too (a partial app-data clear, an OS bug). The heal is gated on the ERROR, never on
// `Platform.OS`.
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
 *   - `missing_key` — the key store has nothing; the DB (if present) is unreadable ciphertext, so
 *     the same destroy-and-re-enrol applies. (In the restore path `bootstrap()` mints a key before
 *     opening, so the live symptom is the next case; this covers a key that vanished on its own.)
 *   - `driver_open_failed` classified `not_a_database` — SQLCipher's wrong-key symptom, the restore
 *     case. `classifyDbError` matches SQLite's own "file is not a database" / "file is encrypted or
 *     is not a database" text, which `connection.ts`'s `sanitizeOpenFailure` carries verbatim into
 *     BOTH the `DbOpenError` message and its `cause` (the key is redacted, the phrase is not).
 *
 * SURFACE (return false — `Root.tsx`'s no-catch keeps failing loudly, which is correct for these):
 *   - `driver_open_failed` that is an I/O / disk error (classifies `unknown`) — a TRANSIENT or
 *     hardware failure. Wiping a good-but-momentarily-unopenable DB is worse than the brick (task
 *     acceptance + §2.5-adjacent data safety), so a transient must never reach the wipe.
 *   - `already_open` / `not_open` — one-connection / lifecycle bugs, not an unreadable file.
 *   - anything that is NOT a `DbOpenError` — a migration / registration / keystore throw, unrelated
 *     to key-vs-ciphertext; a wipe would destroy a DB that opened fine.
 */
/**
 * ⚠️ KNOWN GAP SINCE D22 — THIS SELF-HEAL NO LONGER FIRES FOR THE CASE IT WAS BUILT FOR.
 *
 * The scenario is the iOS restore-to-new-hardware path (security-guide §6.6): `bolusi.db` restores,
 * the THIS_DEVICE_ONLY key does not. Under SQLCipher that produced a LOUD boot failure — `open()` was
 * handed a freshly-minted key, SQLCipher rejected the file, and `not_a_database` routed here to wipe
 * and re-enrol. **Post-D22 neither trigger can occur:** `ensureDatabaseEncryptionKey()` mints a key
 * (so never `missing_key`), and `open()` takes no key at all, so the restored PLAINTEXT SQLite file
 * **opens successfully** (so never `not_a_database`). Boot then "succeeds": `readDeviceId` reads
 * plaintext `meta_kv` and the app believes it is the old device, while every read of a protected
 * column throws an AEAD authentication error deep in the UI.
 *
 * That is strictly worse than the brick it replaced — a loud, self-healing boot failure became a
 * silent half-enrolled state — and it is NOT fixed here: detecting it needs a boot-time probe that
 * tries to decrypt a known cell and treats failure as "this file is not ours", which is new boot
 * semantics (what to do on an EMPTY DB, on a partial write, on a transient) and deserves its own
 * task and its own adversarial tests rather than being smuggled into the 148 diff. Filed as a
 * disclosure, deliberately unfixed. Do not read the branches below as covering the restore case.
 */
export function isUnrecoverableLocalDbError(error: unknown): boolean {
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
