// The device's two key stores over a platform's secret storage: the database key is minted once and
// never replaced; the signing key is cached in memory after one load, because the runtime signs
// inside the append transaction and cannot await storage per op. The PC binds its DPAPI-sealed
// secret file; the item names match the phone's SecureStore ones.
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  type CryptoPort,
  type KeyStorePort,
} from '@bolusi/core';
import type { BootDbKeyStore } from '../bootstrap/bootstrap.js';

/** A platform's secret storage: small strings, sealed at rest. */
export interface SecretsPort {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const DB_ENCRYPTION_KEY = 'bolusi.db_encryption_key';
const DEVICE_PRIVATE_KEY = 'bolusi.device_private_key';
const DEVICE_TOKEN = 'bolusi.device_token';
const DB_KEY_BYTES = 32;

export class SecretDbKeyStore implements BootDbKeyStore {
  #inFlight: Promise<string> | null = null;

  constructor(
    private readonly secrets: SecretsPort,
    private readonly crypto: CryptoPort,
  ) {}

  getDatabaseEncryptionKey(): Promise<string | null> {
    return this.secrets.get(DB_ENCRYPTION_KEY);
  }

  async ensureDatabaseEncryptionKey(): Promise<string> {
    this.#inFlight ??= this.#readOrGenerate();
    try {
      return await this.#inFlight;
    } finally {
      this.#inFlight = null;
    }
  }

  async #readOrGenerate(): Promise<string> {
    const existing = await this.secrets.get(DB_ENCRYPTION_KEY);
    if (existing !== null && existing !== '') return existing;
    const key = bytesToHex(this.crypto.randomBytes(DB_KEY_BYTES));
    await this.secrets.set(DB_ENCRYPTION_KEY, key);
    return key;
  }

  wipe(): Promise<void> {
    return this.secrets.delete(DB_ENCRYPTION_KEY);
  }
}

export class SecretKeyStore implements KeyStorePort {
  #signingKey: Uint8Array | null = null;

  constructor(private readonly secrets: SecretsPort) {}

  async persistDevicePrivateKey(seed: Uint8Array): Promise<void> {
    await this.secrets.set(DEVICE_PRIVATE_KEY, bytesToBase64(seed));
    this.#signingKey = Uint8Array.from(seed);
  }

  persistDeviceToken(token: string): Promise<void> {
    return this.secrets.set(DEVICE_TOKEN, token);
  }

  loadDeviceToken(): Promise<string | null> {
    return this.secrets.get(DEVICE_TOKEN);
  }

  async loadSigningKey(): Promise<Uint8Array | null> {
    const encoded = await this.secrets.get(DEVICE_PRIVATE_KEY);
    if (encoded === null) return null;
    this.#signingKey = base64ToBytes(encoded);
    return this.#signingKey;
  }

  getSigningKey(): Uint8Array {
    if (this.#signingKey === null) {
      throw new Error('device signing key not loaded; await loadSigningKey() before signing');
    }
    return this.#signingKey;
  }

  async wipe(): Promise<void> {
    this.#signingKey = null;
    await this.secrets.delete(DEVICE_PRIVATE_KEY);
    await this.secrets.delete(DEVICE_TOKEN);
  }
}
