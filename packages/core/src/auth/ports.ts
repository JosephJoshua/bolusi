// The injected effect seams the auth runtime needs beyond the command runtime's (runtime/ports.ts).
//
// @bolusi/core is PLATFORM-FREE (08 §3.3): it never imports expo-secure-store or a transport. These
// interfaces are what `apps/mobile` binds (SecureStore for the keystore, the sync client's fetch for
// the transport) and what tests fake. Everything effectful is here so the whole auth runtime is
// constructible on Node from fakes (the task's headless-on-Node requirement).
import type { PinVerifier } from './verifier.js';

/**
 * The device's SecureStore surface (api/02-auth §3): the two credentials this surface owns —
 * `bolusi.device_private_key` (32-byte Ed25519 seed) and `bolusi.device_token` — plus the sync
 * signing seam the command runtime reads at append time.
 *
 * WHY IT CARRIES BOTH ASYNC AND SYNC METHODS. SecureStore reads are async, but op signing (05 §2.2)
 * happens synchronously inside the append transaction (04 §5.1) and cannot await a keychain round
 * trip per op. So the seed is loaded once (`loadSigningKey`, async) and thereafter returned
 * synchronously (`getSigningKey`) from an in-memory cache. That sync method makes a bound
 * `KeyStorePort` structurally satisfy the command runtime's `SigningKeyPort` (runtime/ports.ts) —
 * which is the unification that interface's comment anticipated, achieved without deleting a seam the
 * runtime still needs synchronously.
 */
export interface KeyStorePort {
  /** Persist the 32-byte Ed25519 seed to `bolusi.device_private_key` (§4.1 step 1). Caches it. */
  persistDevicePrivateKey(seed: Uint8Array): Promise<void>;
  /** Persist the opaque device token to `bolusi.device_token` (§4.1 step 5). */
  persistDeviceToken(token: string): Promise<void>;
  /** Load the token, or null when unenrolled. */
  loadDeviceToken(): Promise<string | null>;
  /**
   * Load the 32-byte seed into the in-memory cache and return it (or null when unenrolled). MUST be
   * awaited once at startup before the command runtime signs its first op.
   */
  loadSigningKey(): Promise<Uint8Array | null>;
  /**
   * The cached seed, synchronously (05 §2.2 signing). Satisfies the runtime's `SigningKeyPort`.
   * @throws if called before `persistDevicePrivateKey`/`loadSigningKey` cached it — a signing call
   *   on an unenrolled device is a bug, not a silent empty key.
   */
  getSigningKey(): Uint8Array;
  /** Crypto-erase on revocation (api/02-auth §7.3): delete both keys. The DB key is owned elsewhere. */
  wipe(): Promise<void>;
}

/** What `POST /v1/devices/enroll` returns (api/02-auth §4.3). LOCAL STOPGAP — see verifier.ts. */
export interface EnrollResponse {
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly tenant: { readonly id: string; readonly name: string };
  readonly store: { readonly id: string; readonly name: string };
  readonly settings: { readonly idleLockSeconds: number };
  readonly bundle: DeviceBundle;
  readonly bundleEtag: string;
  readonly serverTime: number;
}

/** The device bundle (api/02-auth §5.2). LOCAL STOPGAP — DELETE for `@bolusi/schemas` (task 33). */
export interface DeviceBundle {
  readonly tenant: { readonly id: string; readonly name: string };
  readonly store: { readonly id: string; readonly name: string };
  readonly settings: { readonly idleLockSeconds: number };
  readonly users: readonly BundleUser[];
  readonly rolesSnapshot: readonly BundleRole[];
  readonly permissionsSnapshot: readonly BundlePermission[];
}

export interface BundleUser {
  readonly id: string;
  readonly name: string;
  readonly photoMediaId: string | null;
  readonly status: 'active' | 'deactivated';
  readonly grants: readonly { readonly roleId: string; readonly storeId: string | null }[];
  readonly pinVerifier: PinVerifier | null;
}

export interface BundleRole {
  readonly id: string;
  readonly name: string;
  readonly scopeType: 'tenant' | 'store';
  readonly isSystemDefault: boolean;
  readonly permissionIds: readonly string[];
}

export interface BundlePermission {
  readonly id: string;
  readonly module: string;
  readonly action: string;
  readonly scope: 'tenant' | 'store';
  readonly isDangerous: boolean;
  readonly description: string;
}

/** The enrollment request body (api/02-auth §4.3), minus the client-generated envelope fields. */
export interface EnrollRequest {
  readonly deviceId: string;
  readonly devicePublicKeyB64: string;
  readonly storeId: string;
  readonly deviceName: string;
  readonly platform: 'android' | 'ios';
  readonly appVersion: string;
}

/**
 * The `POST /v1/devices/enroll` transport (api/02-auth §4.3). The `Idempotency-Key` is REQUIRED and
 * passed explicitly so a crash-retry can reuse the SAME key (§4.3): the server returns the stored
 * response verbatim, including the token, so a client that crashed before persisting the token can
 * recover without double-registering the device.
 */
export interface EnrollTransportPort {
  enroll(
    controlSession: string,
    idempotencyKey: string,
    body: EnrollRequest,
  ): Promise<EnrollResponse>;
}

/** The `POST /v1/users/:userId/pin-verifier` response (api/02-auth §5.4). */
export interface PinVerifierUploadResult {
  readonly userId: string;
  /** `false` ⇒ the server had a newer verifier; the POST was a stale no-op (§5.3). Terminal. */
  readonly applied: boolean;
}

/**
 * The `POST /v1/users/:userId/pin-verifier` transport (api/02-auth §5.4). Sent on next online
 * contact by the pending-verifier queue (pin-flows.ts); a `applied: false` answer is terminal — the
 * server already holds a newer verifier, so there is nothing to retry and nothing to roll back.
 */
export interface PinVerifierUploadPort {
  upload(
    userId: string,
    verifierRef: string,
    verifier: PinVerifier,
  ): Promise<PinVerifierUploadResult>;
}
