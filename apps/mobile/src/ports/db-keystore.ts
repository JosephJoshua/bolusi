// The SQLCipher key's SecureStore binding — `bolusi.db_encryption_key` (security-guide §6.4).
//
// ── WHY THIS FILE EXISTS: NOBODY PRODUCED THIS KEY ─────────────────────────────────────────────
// Before task 50 the key had an interface, two consumers and ZERO producers. `DbKeyStore`
// (db-client/connection.ts) declared `getDatabaseEncryptionKey()`; `openClientDb` called it; every
// other reference in the repo was a test fake. The two files that name the key point at each other:
//
//   db-client/connection.ts  — "the real SecureStore-backed `KeyStorePort` (tasks 14/24) satisfies
//                              this" — it does NOT: `KeyStorePort` (core/auth/ports.ts) declares no
//                              `getDatabaseEncryptionKey`, so `SecureStoreKeyStore` is not
//                              assignable to `DbKeyStore`. That comment was checked and corrected.
//   ports/keystore.ts        — "`bolusi.db_encryption_key` is NOT here — that belongs to
//                              security-guide §6.4 / @bolusi/db-client".
//
// Each deferred to the other and the ring closed, which is why `grep getDatabaseEncryptionKey` found
// only fakes (T-16: a mention is not a producer). This file is the producer.
//
// ── WHY HERE AND NOT IN db-client ──────────────────────────────────────────────────────────────
// §6.4 says "the wrapper is the only place the key is ever READ from SecureStore", and that property
// is preserved in shape rather than in letter: `openClientDb` is the only caller of
// `getDatabaseEncryptionKey()`, it passes the value straight to the driver, and it never returns,
// logs or stores it. The SecureStore *binding* lives here because db-client's package entry must stay
// importable under Node (its own suite and core's projection tests import it), and expo-secure-store
// is a native module that cannot load there — the same reason the op-sqlite adapter sits behind a
// subpath. 08 §3.2 puts the SecureStore bindings in `@bolusi/mobile`'s row. The residual mismatch
// between §6.4's wording and this shape is filed, not papered over — see the task Outcome.
//
// ── STORAGE CLAIM, QUALIFIED (security-guide §6.2; api/02-auth §3) ─────────────────────────────
// SecureStore is **encrypted-at-rest, app-readable** storage — NOT a non-extractable enclave. The
// app can read this key back (it must, to open the DB), so a compromise that runs as this app reads
// it. That is the documented, accepted property; the answer to a compromised device is revocation
// (api/02-auth §7), not storage magic. Do not upgrade this comment to a stronger claim.
//
// ── KEY LOSS IS DATA LOSS, BY DESIGN (§6.4) ────────────────────────────────────────────────────
// There is no escrow and no recovery path: SecureStore wipe / app-data clear ⇒ the DB is
// unreadable ciphertext ⇒ re-enroll and re-pull. That is what makes `ensureDatabaseEncryptionKey`'s
// read-before-generate load-bearing rather than an optimisation — see its own comment.
import * as SecureStore from 'expo-secure-store';

import { bytesToHex, type CryptoPort } from '@bolusi/core';
import type { DbKeyStore } from '@bolusi/db-client';

/** security-guide §6.4's key. Owned by THIS surface; `ports/keystore.ts` owns the other two. */
export const DB_ENCRYPTION_KEY = 'bolusi.db_encryption_key';

/** §6.4: "Key = 32 CSPRNG bytes". Hex-encoded ⇒ 64 chars, far inside SecureStore's 2 KB limit. */
export const DB_KEY_BYTES = 32;

const OPTIONS: SecureStore.SecureStoreOptions = {
  // iOS-only: Android accepts and ignores this field. See ports/keystore.ts's platform note — the
  // §7.4 "never resurrected" property is carried by Android Keystore + the backup exclusion there,
  // and by this option on iOS (D17: iOS is a first-class target). Kept identical to the other
  // credentials so all four SecureStore items share one storage policy.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * The SecureStore-backed `DbKeyStore` — structurally what `openClientDb` injects.
 *
 * Satisfies `DbKeyStore` (db-client) by structure, not by inheritance: db-client declares that
 * interface locally and on purpose so it need not import a port module from a contended package.
 */
// MODULE-SCOPED single-flight (mirrors `current` in connection.ts:113). The guard must outlive any
// single instance: production builds a FRESH `SecureStoreDbKeyStore` on every `boot()` (index.ts),
// so a per-instance promise would let two concurrent boots each read `null`, each generate, and the
// second `setItemAsync` overwrite the first — orphaning the DB under a key nobody has, permanently,
// no escrow. Keyed at module scope, "exactly one generation per PROCESS" is true regardless of how
// many keystores or boots race. Reset in `finally` so a post-wipe re-enrol can generate again.
let inFlightKeyGeneration: Promise<string> | null = null;

export class SecureStoreDbKeyStore implements DbKeyStore {
  /**
   * @param crypto The CSPRNG (§6.4: "32 CSPRNG bytes (quick-crypto)"). Injected rather than
   *   imported so this class is drivable under Node — and so the randomness source is a stated
   *   dependency rather than an ambient `Math.random` nobody would notice.
   */
  constructor(private readonly crypto: CryptoPort) {}

  /**
   * The `DbKeyStore` surface `openClientDb` reads. Returns `null` when the device has no key —
   * `openClientDb` then refuses to open rather than falling back to plaintext (SEC-DEV-06).
   *
   * Deliberately NOT generate-on-read: a read that quietly minted a key would turn "this device's
   * key is gone" into "here is a fresh key", and the DB would fail to open with a *wrong-key* error
   * instead of a missing-key one. Generation is `ensureDatabaseEncryptionKey`, called once at
   * bootstrap, where the decision is visible.
   */
  async getDatabaseEncryptionKey(): Promise<string | null> {
    return SecureStore.getItemAsync(DB_ENCRYPTION_KEY, OPTIONS);
  }

  /**
   * Read the key, or mint one on first boot (§6.4: "generated **once**").
   *
   * READ-BEFORE-GENERATE IS THE WHOLE FUNCTION. Overwriting an existing key orphans the database
   * permanently: the file stays encrypted under the old key, there is no escrow (§6.4), and the
   * failure surfaces later as "cannot open" on a device full of a shop's unsynced work. So the
   * existing value always wins, and this method never writes when one is present.
   *
   * SINGLE-FLIGHT FOR THE SAME REASON. Two concurrent callers on a fresh device would each read
   * `null`, each generate, and the second `setItemAsync` would overwrite the first — after the
   * first had already opened the DB under its value. That is the orphaning bug arriving by race
   * rather than by edit. The promise is shared AT MODULE SCOPE (not per-instance — production builds a fresh keystore
   * per boot), so exactly one generation happens per process however many boots or instances race.
   */
  async ensureDatabaseEncryptionKey(): Promise<string> {
    inFlightKeyGeneration ??= this.#readOrGenerate();
    try {
      return await inFlightKeyGeneration;
    } finally {
      inFlightKeyGeneration = null;
    }
  }

  async #readOrGenerate(): Promise<string> {
    const existing = await SecureStore.getItemAsync(DB_ENCRYPTION_KEY, OPTIONS);
    // An empty string is treated as absent: `openClientDb` rejects `''` as `missing_key`, so
    // returning it here would produce a `missing_key` throw on a device we could have healed.
    if (existing !== null && existing !== '') return existing;

    const key = bytesToHex(this.crypto.randomBytes(DB_KEY_BYTES));
    await SecureStore.setItemAsync(DB_ENCRYPTION_KEY, key, OPTIONS);
    return key;
  }

  /**
   * api/02-auth §7.3 step 1 — the FIRST deletion of the wipe, and the reason the order matters:
   * removing this key is the crypto-erase. From this moment the DB is unreadable ciphertext even if
   * the remaining steps (the seed, the token — `ports/keystore.ts`) are interrupted by a crash.
   */
  async wipe(): Promise<void> {
    await SecureStore.deleteItemAsync(DB_ENCRYPTION_KEY, OPTIONS);
  }
}
