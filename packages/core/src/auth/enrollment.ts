// Device enrollment flow logic (api/02-auth §4.1; SEC-DEV-05).
//
// THE STEP ORDER IS THE CONTRACT (§4.1), and each step's placement is load-bearing:
//   1. generate deviceId + Ed25519 keypair; private seed → SecureStore IMMEDIATELY, and it never
//      leaves the device (SEC-DEV-05).
//   2. persist an enrollment draft (deviceId + Idempotency-Key) BEFORE the POST, so a crash-retry
//      reuses the SAME key (§4.3): the server returns the stored response verbatim (token included),
//      and the device is never double-registered.
//   3. POST /v1/devices/enroll.
//   4. on the response: token → SecureStore, bundle → the client DIRECTORY tables (before ANY command
//      executes — the evaluator reads exactly those, 02-permissions §6 bootstrap rule).
//   5. genesis op `auth.device_enrolled` (seq 1) — appended ONLY AFTER the directory persist, so the
//      one op whose validity never depends on directory state is also the one written before there is
//      a directory to depend on (§4.1 step 6; evaluator-exempt, 02-permissions §4).
//
// Enrollment logs NOBODY in (§4.4): it returns with no open session — the device shows the switcher,
// and the enrolling owner authenticates by PIN like everyone else.
import type { Kysely } from 'kysely';

import type { CryptoPort } from '../crypto/port.js';
import { bytesToBase64 } from '../crypto/bytes.js';
import type { AppendedOp } from '../oplog/append.js';
import type { CommandRuntime, DeviceIdentity } from '../runtime/execute.js';
import type { IdSource } from '../runtime/ports.js';
import { applyBundle } from './bundle-apply.js';
import { AUTH_ENTITY, AUTH_OP } from './operations.js';
import type { EnrollResponse, EnrollTransportPort, KeyStorePort } from './ports.js';
import {
  deleteMeta,
  deviceHasGenesis,
  readMeta,
  writeMeta,
  DEVICE_ID_META_KEY,
  STORE_ID_META_KEY,
} from './repo.js';

/** The `meta_kv` key holding the in-flight enrollment draft (crash-retry state). */
const ENROLLMENT_DRAFT_KEY = 'auth.enrollment_draft';

/** The persisted, crash-durable part of an in-flight enrollment (§4.3 Idempotency-Key reuse). */
interface EnrollmentDraft {
  readonly deviceId: string;
  readonly idempotencyKey: string;
  readonly devicePublicKeyB64: string;
}

export interface EnrollmentDeps<DB> {
  readonly db: Kysely<DB>;
  readonly crypto: CryptoPort;
  readonly idSource: IdSource;
  readonly keystore: KeyStorePort;
  readonly transport: EnrollTransportPort;
  /**
   * Build the command runtime for the newly-known device identity. Enrollment cannot pre-build it —
   * the deviceId, tenantId and storeId are only known mid-flow — so the app supplies a factory that
   * closes over the shared ports (evaluator, store, crypto, clock…) and the keystore-backed signing
   * key. Used only to emit the genesis op through the sanctioned channel (04 §5.1).
   */
  readonly runtimeFor: (device: DeviceIdentity) => CommandRuntime;
}

export interface EnrollmentParams {
  /** The owner who logged in (§4.2) — the genesis op's `userId` (§4.1 step 6). */
  readonly ownerUserId: string;
  /** The control session minted by `POST /v1/auth/login` (§4.2). */
  readonly controlSession: string;
  readonly storeId: string;
  readonly deviceName: string;
  readonly platform: 'android' | 'ios';
  readonly appVersion: string;
}

export interface EnrollmentResult {
  readonly deviceId: string;
  readonly response: EnrollResponse;
  readonly genesis: readonly AppendedOp[];
  /** Enrollment opens no session (§4.4) — always false. Present so the property is asserted, not assumed. */
  readonly loggedIn: false;
}

/**
 * Run (or resume) device enrollment (api/02-auth §4.1). Resumable: a draft persisted before the POST
 * makes a crash-retry reuse the same Idempotency-Key and never double-register. Idempotent at the
 * genesis step too — a device that already has seq 1 is not re-enrolled.
 */
export async function runEnrollment<DB>(
  deps: EnrollmentDeps<DB>,
  params: EnrollmentParams,
): Promise<EnrollmentResult> {
  const draft = await loadOrCreateDraft(deps);

  // Step 3 — POST with the draft's Idempotency-Key (reused on retry, §4.3).
  const response = await deps.transport.enroll(params.controlSession, draft.idempotencyKey, {
    deviceId: draft.deviceId,
    devicePublicKeyB64: draft.devicePublicKeyB64,
    storeId: params.storeId,
    deviceName: params.deviceName,
    platform: params.platform,
    appVersion: params.appVersion,
  });

  // Step 4 — token to SecureStore, THEN the bundle into the directory tables. The directory persist
  // precedes any command, so the first evaluator read has rows (§6 bootstrap rule).
  await deps.keystore.persistDeviceToken(response.deviceToken);
  await applyBundle(deps.db, response.bundle);

  // Step 5 — the genesis op, ONLY after the directory persist. Guarded so a resumed run that already
  // appended it does not attempt a second seq 1 (which would fail the genesis rules, 05 §9.5).
  let genesis: readonly AppendedOp[] = [];
  if (!(await deviceHasGenesis(deps.db, draft.deviceId))) {
    const runtime = deps.runtimeFor({
      tenantId: response.tenant.id,
      storeId: response.store.id,
      deviceId: draft.deviceId,
    });
    genesis = await runtime.emitRuntimeOp({
      type: AUTH_OP.deviceEnrolled,
      entityType: AUTH_ENTITY.device,
      entityId: draft.deviceId,
      payload: {
        storeId: response.store.id,
        deviceName: params.deviceName,
        devicePublicKeyB64: draft.devicePublicKeyB64,
      },
      userId: params.ownerUserId,
      source: 'system',
    });
  }

  // Step 7 — persist the device identity to `meta_kv` (10-db §9; task 88), BEFORE the draft is
  // deleted. The ordering is the guarantee: a crash between these writes and the delete leaves a
  // device whose identity is recoverable (deviceId/storeId already durable AND the draft still
  // there), never one whose identity is gone. `storeId` comes from the ENROLL RESPONSE, not the
  // bundle — §7.4's store binding is irreversible and `applyBundle` runs on every refresh, so
  // writing it here is the one place a store binding may be set (bundle-apply.ts writes only tenant).
  await writeMeta(deps.db, DEVICE_ID_META_KEY, draft.deviceId);
  await writeMeta(deps.db, STORE_ID_META_KEY, response.store.id);

  await deleteMeta(deps.db, ENROLLMENT_DRAFT_KEY); // enrollment complete — the draft is spent
  return { deviceId: draft.deviceId, response, genesis, loggedIn: false };
}

/**
 * Resume an in-flight enrollment from the persisted draft, or start a fresh one: generate the
 * deviceId + keypair (§4.1 step 1), persist the private seed to SecureStore immediately, mint the
 * Idempotency-Key, and persist the draft BEFORE any network call (§4.3).
 */
async function loadOrCreateDraft<DB>(deps: EnrollmentDeps<DB>): Promise<EnrollmentDraft> {
  const existing = await readMeta(deps.db, ENROLLMENT_DRAFT_KEY);
  if (existing !== null) return JSON.parse(existing) as EnrollmentDraft;

  const deviceId = deps.idSource();
  const keypair = deps.crypto.ed25519Keygen();
  // Step 1: the private seed goes to SecureStore immediately and never transmits (SEC-DEV-05).
  await deps.keystore.persistDevicePrivateKey(keypair.secretKey);

  const draft: EnrollmentDraft = {
    deviceId,
    idempotencyKey: deps.idSource(),
    devicePublicKeyB64: bytesToBase64(keypair.publicKey),
  };
  await writeMeta(deps.db, ENROLLMENT_DRAFT_KEY, JSON.stringify(draft));
  return draft;
}
