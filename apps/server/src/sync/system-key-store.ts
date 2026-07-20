// The production `SystemKeyStore` (conflict-wiring.ts) — task 78. This is the deployment-owned key
// source 01 §3.6 / 10-db §12 leave to "the server secret store", implemented as the lowest-surprise
// mechanism for v0: a directory of per-tenant Ed25519 signing-key files, one file per tenant, named
// EXACTLY as `provision-tenant` writes them (`system-device-<tenantId>.key`, base64 of the raw
// Ed25519 secret key — cli/provision-tenant.ts `defaultKeyPath`). Injecting one into `resolveDeps`
// (main.ts, keyed on `SYSTEM_KEY_DIR`) is what FLIPS conflict detection on in production; before
// this, main.ts injected nothing, so `detectConflicts` was undefined and detection was a visible
// no-op (deps.ts / conflict-wiring.ts header).
//
// ── WHY A DIRECTORY OF FILES (the §6 deployment shape) ──────────────────────────────────────────
//
// 01 §3.6 / 10-db §12 name the storage as a DEPLOYMENT decision (KMS or env secret), not a spec
// one — so this file makes it, minimally and reversibly. v0 is a single operator running
// `provision-tenant` per tenant, which already emits a 0600 `system-device-<tenantId>.key` file and
// tells the operator to "move it to the server secret store (10-db §12)". This store IS that secret
// store for v0: point `SYSTEM_KEY_DIR` at a directory holding those files. A multi-tenant server
// needs a per-tenant lookup, which a single env var cannot hold and a directory keyed by tenant id
// is exactly — and a KMS is heavier than v0 warrants. The `SystemKeyStore` PORT is the seam that
// keeps this reversible: swapping this for a KMS-backed store later touches ONLY main.ts, never the
// pipeline.
//
// ── ABSENCE vs ERROR (conflict-wiring.ts contract) ─────────────────────────────────────────────
//
//   * NO file for a tenant ⇒ `undefined` (NOT an error): "this tenant has no configured key". A
//     store must never THROW for a missing key — that would be indistinguishable from a real
//     failure. NOTE what this does NOT buy: it is not a graceful per-tenant "detection off".
//     Detection is enabled server-wide on whether a store was injected at all (deps.ts), so with
//     `SYSTEM_KEY_DIR` set, a tenant missing its file THROWS at emission in `systemIdentity`
//     (conflict-wiring.ts) and rolls that push back. Missing file = BROKEN, not off. Only an unset
//     `SYSTEM_KEY_DIR` is the graceful default (08-stack-and-repo §8.1).
//   * A file that exists but does not decode to a valid Ed25519 secret key ⇒ THROW. The store HAS a
//     key and cannot produce a signer: a real, loud error. A truncated/corrupt secret must not be
//     silently treated as "no detection" — that is the §2.11 silent-no-op class.
//
// ── SECURITY (§2.5 / security-guide) ────────────────────────────────────────────────────────────
//
//   * The loaded private key stays in server memory (inside a signer closure); it is NEVER logged,
//     and errors carry the tenant id + the failure shape, NEVER key bytes (the gitleaks pre-commit
//     scan + SEC-SECRET-02 are the backstop).
//   * The key never touches Postgres (10-db §12): this reads it from disk, off the RLS plane. Only
//     the PUBLIC key lives in `devices.signing_key_public`.
//   * PATH TRAVERSAL: the tenant id is interpolated into a filename, so it is validated against a
//     strict UUID shape BEFORE any path is built. A tenant id that is not a plain UUID reads NO file
//     and returns `undefined` — there is no `..`/separator that can escape `SYSTEM_KEY_DIR`.
//   * A wrong key for a tenant is caught downstream too: `appendSystemOp` self-verifies every emitted
//     op against the tenant's system-device PUBLIC key, so a mis-provisioned key fails loudly at
//     emission (rolling the push back) rather than shipping an unverifiable op to clients.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { base64ToBytes, type CryptoPort } from '@bolusi/core';

import type { ServerConfig } from '../config.js';
import type { SystemSigner } from '../oplog/system-op.js';
import type { SystemKeyStore } from './conflict-wiring.js';

/** A tenant id is a UUID (uuidv7) — the traversal guard: anything else builds no path. */
const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The filename `provision-tenant` writes (cli/provision-tenant.ts `defaultKeyPath`). */
function keyFileName(tenantId: string): string {
  return `system-device-${tenantId}.key`;
}

/** Node's ENOENT — the ONLY read error that means "no configured key" (⇒ undefined, not throw). */
function isFileNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/** Read a file as a trimmed string, or `undefined` if it does not exist; other IO errors rethrow. */
export type ReadKeyFile = (path: string) => string | undefined;

const defaultReadKeyFile: ReadKeyFile = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (isFileNotFound(err)) return undefined;
    throw err; // EACCES / EISDIR / … is a real misconfiguration — never silently "no key".
  }
};

/**
 * A `SystemKeyStore` backed by a directory of `system-device-<tenantId>.key` files.
 *
 * Signers are cached per tenant: the system-device key is immutable (rotation = revoke + re-enroll
 * as a new device, 01 §3.6), and detection runs on the push hot path, so re-reading + re-decoding
 * per collision buys nothing. The cached value is a closure over the secret bytes — held in memory
 * exactly as long as the process, never logged.
 */
export class DirectorySystemKeyStore implements SystemKeyStore {
  readonly #dir: string;
  readonly #crypto: CryptoPort;
  readonly #readKeyFile: ReadKeyFile;
  readonly #cache = new Map<string, SystemSigner>();

  constructor(dir: string, crypto: CryptoPort, readKeyFile: ReadKeyFile = defaultReadKeyFile) {
    this.#dir = dir;
    this.#crypto = crypto;
    this.#readKeyFile = readKeyFile;
  }

  getSystemSigner(tenantId: string): SystemSigner | undefined {
    const cached = this.#cache.get(tenantId);
    if (cached !== undefined) return cached;

    // Traversal guard BEFORE any path is built: a non-UUID tenant id is not a real tenant, so it
    // has no configured key (undefined), and no filename derived from it can escape the directory.
    if (!TENANT_ID_RE.test(tenantId)) return undefined;

    const contents = this.#readKeyFile(join(this.#dir, keyFileName(tenantId)));
    // No file ⇒ no configured key. NOT a per-tenant "detection off": with the dir set, this makes
    // `systemIdentity` throw at emission (see the ABSENCE vs ERROR block in the header).
    if (contents === undefined) return undefined;

    const secretKey = this.#decodeSecretKey(contents.trim(), tenantId);
    const signer: SystemSigner = (hash) => this.#crypto.sign(hash, secretKey);
    this.#cache.set(tenantId, signer);
    return signer;
  }

  /**
   * Decode + VALIDATE the secret key at load time (not on first sign): a corrupt or wrong-length
   * secret must fail loudly here — this is the "has a key but cannot produce a signer" error case.
   * Deriving the public key exercises the same length/validity checks `sign` would, without ever
   * putting the key bytes in an error message.
   */
  #decodeSecretKey(base64: string, tenantId: string): Uint8Array {
    let secretKey: Uint8Array;
    try {
      secretKey = base64ToBytes(base64);
      this.#crypto.ed25519GetPublicKey(secretKey); // throws on a non-Ed25519-secret-length input.
    } catch (err) {
      throw new Error(
        `system key for tenant ${tenantId} is not a valid Ed25519 secret key (SYSTEM_KEY_DIR): ${
          err instanceof Error ? err.name : 'decode failed'
        }`,
      );
    }
    return secretKey;
  }
}

/**
 * Build the production `SystemKeyStore` from config — the composition-root helper main.ts calls.
 *
 * Returns `undefined` when no `SYSTEM_KEY_DIR` is configured, which is what leaves `detectConflicts`
 * undefined in `resolveDeps` (deps.ts) — the honest "detection off" default. Extracted from main.ts
 * (which reads argv + calls `serve`/`process.exit` and is not unit-testable) so the config→store
 * wiring is a pure function a test can drive directly.
 */
export function systemKeyStoreFromConfig(
  config: ServerConfig,
  crypto: CryptoPort,
): SystemKeyStore | undefined {
  if (config.systemKeyDir === undefined) return undefined;
  return new DirectorySystemKeyStore(config.systemKeyDir, crypto);
}
