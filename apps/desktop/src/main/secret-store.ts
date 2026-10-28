// The PC's secret store: the database key, the device's signing key and its server token. Each value
// is sealed with Electron's safeStorage (Windows DPAPI, so only this Windows account on this PC can
// open it) and kept in one small file in the app's data folder. Only the main process can reach
// safeStorage, so the core asks for secrets over its channel to main.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeStorage } from 'electron';

/** The names the core may read and write; anything else is refused. */
export const SECRET_NAMES = [
  'bolusi.db_encryption_key',
  'bolusi.device_private_key',
  'bolusi.device_token',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const NAMES: ReadonlySet<string> = new Set(SECRET_NAMES);

export interface SecretStore {
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): void;
}

/**
 * @param unsealedForDev A development run on Linux with no keyring (a CI box, a container): seal with
 * Electron's fixed key so the app can be driven at all. Never set for an installed app.
 */
export function createSecretStore(folder: string, unsealedForDev = false): SecretStore {
  if (unsealedForDev && !safeStorage.isEncryptionAvailable()) {
    safeStorage.setUsePlainTextEncryption(true);
  }
  const file = join(folder, 'secrets.json');
  const read = (): Record<string, string> => {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  };
  // Written beside and renamed over, so a power cut mid-write leaves the old file whole.
  const write = (sealed: Record<string, string>): void => {
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(sealed), { mode: 0o600 });
    renameSync(temp, file);
  };
  const check = (name: string): void => {
    if (!NAMES.has(name)) throw new Error(`unknown secret ${name}`);
  };
  const requireEncryption = (): void => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('this PC cannot protect secrets (safeStorage is unavailable)');
    }
  };
  return {
    get(name) {
      check(name);
      const sealed = read()[name];
      if (sealed === undefined) return null;
      requireEncryption();
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'));
    },
    set(name, value) {
      check(name);
      requireEncryption();
      write({ ...read(), [name]: safeStorage.encryptString(value).toString('base64') });
    },
    delete(name) {
      check(name);
      const sealed = read();
      if (!(name in sealed)) return;
      delete sealed[name];
      write(sealed);
    },
  };
}
