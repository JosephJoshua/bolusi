// The device `KeyStorePort` binding — expo-secure-store (api/02-auth §3; 08 §3.2).
//
// It owns exactly TWO of the four credentials (api/02-auth §3): `bolusi.device_private_key` (the
// 32-byte Ed25519 seed, base64 — the crown jewel, PRD-011 §8) and `bolusi.device_token` (the opaque
// bearer secret). `bolusi.db_encryption_key` is NOT here — that belongs to security-guide §6.4 /
// @bolusi/db-client; it appears in this surface only as the FIRST deletion of the §7.3 wipe, which
// the revocation handler (task 15) drives.
//
// STORAGE CLAIM, QUALIFIED (08 §2.2, D10; security-guide §6.2). SecureStore gives
// **encrypted-at-rest, app-readable** storage — Android Keystore-wrapped, iOS Keychain. It is NOT a
// non-extractable hardware enclave: the app can read the seed back (it must, to sign every op), so a
// device compromise that can run as this app can read it. That is the documented, accepted property;
// the response to a compromised device is revocation (§7), not storage magic. Do not upgrade this
// comment to a stronger claim without a doc change.
//
// `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` is deliberate: the entry needs the device
// unlocked, and `THIS_DEVICE_ONLY` keeps it out of encrypted backups/restores, so a device identity
// is never resurrected onto different hardware (§7.4 — re-enrollment always means a fresh keypair).
// `requireAuthentication` (biometric) is NOT set: it is defence-in-depth only and out of v0
// (security-guide §6.2), and enabling it would block background sync signing.
import * as SecureStore from 'expo-secure-store';

import { base64ToBytes, bytesToBase64, type KeyStorePort } from '@bolusi/core';

/** The 32-byte Ed25519 seed, base64 (api/02-auth §3). ~44 chars — far inside the 2 KB item limit. */
const DEVICE_PRIVATE_KEY = 'bolusi.device_private_key';
/** The opaque `bdt_`-prefixed device token (api/02-auth §3/§8). */
const DEVICE_TOKEN = 'bolusi.device_token';

/** SecureStore's 2 KB per-item limit (api/02-auth §3: "each value < 2 KB"). Enforced, not assumed. */
const MAX_ITEM_BYTES = 2048;

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

function assertUnder2Kb(key: string, value: string): void {
  // The values are a 44-char base64 seed and a ~48-char token, so this can only fire if something
  // upstream changed shape — which is exactly when a silent SecureStore failure would be worst.
  if (value.length > MAX_ITEM_BYTES) {
    throw new Error(
      `${key} is ${String(value.length)} bytes — SecureStore items must stay under ${String(MAX_ITEM_BYTES)} (api/02-auth §3)`,
    );
  }
}

/**
 * The expo-secure-store `KeyStorePort` (api/02-auth §3).
 *
 * The seed is CACHED in memory after the first persist/load so `getSigningKey()` can be synchronous:
 * op signing happens inside the append transaction (04 §5.1) and cannot await a Keychain round trip
 * per op. That sync method is also what makes this port structurally satisfy the command runtime's
 * `SigningKeyPort` (core runtime/ports.ts) — one object binds both seams.
 */
export class SecureStoreKeyStore implements KeyStorePort {
  #signingKey: Uint8Array | null = null;

  async persistDevicePrivateKey(seed: Uint8Array): Promise<void> {
    const encoded = bytesToBase64(seed);
    assertUnder2Kb(DEVICE_PRIVATE_KEY, encoded);
    await SecureStore.setItemAsync(DEVICE_PRIVATE_KEY, encoded, OPTIONS);
    this.#signingKey = Uint8Array.from(seed);
  }

  async persistDeviceToken(token: string): Promise<void> {
    assertUnder2Kb(DEVICE_TOKEN, token);
    await SecureStore.setItemAsync(DEVICE_TOKEN, token, OPTIONS);
  }

  async loadDeviceToken(): Promise<string | null> {
    return SecureStore.getItemAsync(DEVICE_TOKEN, OPTIONS);
  }

  async loadSigningKey(): Promise<Uint8Array | null> {
    const encoded = await SecureStore.getItemAsync(DEVICE_PRIVATE_KEY, OPTIONS);
    if (encoded === null) return null;
    this.#signingKey = base64ToBytes(encoded);
    return this.#signingKey;
  }

  getSigningKey(): Uint8Array {
    if (this.#signingKey === null) {
      throw new Error(
        'device signing key not loaded — await loadSigningKey() at startup before the runtime signs (api/02-auth §3). An unenrolled device has no key to sign with.',
      );
    }
    return this.#signingKey;
  }

  /**
   * Crypto-erase this surface's two keys (api/02-auth §7.3 steps 1). The DB encryption key is
   * deleted FIRST by the revocation handler (task 15) — it owns the ordering, because deleting it is
   * what makes the DB unreadable ciphertext even if the later steps are interrupted.
   */
  async wipe(): Promise<void> {
    this.#signingKey = null;
    await SecureStore.deleteItemAsync(DEVICE_PRIVATE_KEY, OPTIONS);
    await SecureStore.deleteItemAsync(DEVICE_TOKEN, OPTIONS);
  }
}
