// Compile-checked type assertions (task 02 acceptance). This file is included in
// the package typecheck (`tsc --noEmit`), which the root `pnpm typecheck` runs —
// optionality drift breaks the build. The signed core's nullable fields must
// infer `T | null`, never `T | undefined` (05 §3; 08 §4.1: exactOptionalPropertyTypes
// is load-bearing for exactly this distinction).
import type {
  ClientBookkeeping,
  DeviceInfo,
  ErrorEnvelope,
  HttpErrorCode,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  PushResult,
  RejectionCode,
  ServerBookkeeping,
  SignedCore,
  SignedOperation,
  SyncStatus,
  WsMessage,
} from '../src/index.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// --- signed core: absent-vs-null (05 §3) ---
export type AssertStoreIdNullNotUndefined = Expect<Equal<SignedCore['storeId'], string | null>>;
export type AssertLocationNullNotUndefined = Expect<
  Equal<SignedCore['location'], { lat: number; lng: number; accuracyMeters: number } | null>
>;
export type AssertAgentConversationIdNullNotUndefined = Expect<
  Equal<SignedCore['agentConversationId'], string | null>
>;
// No key of the signed core may be optional — Required<T> must be an identity.
export type AssertNoOptionalSignedCoreKeys = Expect<Equal<SignedCore, Required<SignedCore>>>;
export type AssertPayloadIsObject = Expect<Equal<SignedCore['payload'], Record<string, unknown>>>;
export type AssertSourceUnion = Expect<
  Equal<SignedCore['source'], 'ui' | 'agent' | 'api' | 'system'>
>;

// --- signed operation = core + derived hash/signature (05 §2.2) ---
export type AssertSignedOperationKeys = Expect<
  Equal<keyof SignedOperation, keyof SignedCore | 'hash' | 'signature'>
>;
export type AssertHashIsString = Expect<Equal<SignedOperation['hash'], string>>;
export type AssertSignatureIsString = Expect<Equal<SignedOperation['signature'], string>>;

// --- enums (05 §8, api/00 §7, 05 §2.3) ---
export type AssertRejectionCodeUnion = Expect<
  Equal<
    RejectionCode,
    | 'BAD_SIGNATURE'
    | 'CHAIN_BROKEN'
    | 'CHAIN_GAP'
    | 'CHAIN_HALTED'
    | 'DEVICE_REVOKED'
    | 'SCHEMA_INVALID'
    | 'SCOPE_VIOLATION'
    | 'UNKNOWN_TYPE'
  >
>;
export type AssertHttpErrorCodeUnion = Expect<
  Equal<
    HttpErrorCode,
    // api/00 §7 transport
    | 'MALFORMED_REQUEST'
    | 'AUTH_TOKEN_MISSING'
    | 'AUTH_TOKEN_INVALID'
    | 'DEVICE_REVOKED'
    | 'PERMISSION_DENIED'
    | 'NOT_FOUND'
    | 'IDEMPOTENCY_CONFLICT'
    | 'BODY_TOO_LARGE'
    | 'DECOMPRESSED_TOO_LARGE'
    | 'UNSUPPORTED_ENCODING'
    | 'VALIDATION_FAILED'
    | 'RATE_LIMITED'
    | 'INTERNAL'
    // api/02-auth §10 identity surface (task 33). No SESSION_EXPIRED — maps to AUTH_TOKEN_INVALID.
    | 'AUTH_INVALID_CREDENTIALS'
    | 'ACTING_USER_INVALID'
    | 'ENROLL_DEVICE_ID_TAKEN'
    | 'ENROLL_KEY_REUSED'
    | 'LAST_ADMIN_PROTECTED'
    | 'LOGIN_IDENTIFIER_TAKEN'
  >
>;
export type AssertSyncStatusUnion = Expect<Equal<SyncStatus, 'local' | 'synced' | 'rejected'>>;

// --- sync DTOs (api/01 §3–4.1) ---
export type AssertPushOpsAreSignedOperations = Expect<Equal<PushRequest['ops'], SignedOperation[]>>;
export type AssertPushDeviceIdRequired = Expect<Equal<PushRequest['deviceId'], string>>;
export type AssertPushResultStatusUnion = Expect<
  Equal<PushResult['status'], 'accepted' | 'duplicate' | 'rejected'>
>;
export type AssertPushResultServerSeqOptional = Expect<
  Equal<PushResult['serverSeq'], number | undefined>
>;
export type AssertPushResponseServerTime = Expect<Equal<PushResponse['serverTime'], number>>;
export type AssertPullCursorRequired = Expect<Equal<PullRequest['cursor'], number>>;
export type AssertPullLimitDefaulted = Expect<Equal<PullRequest['limit'], number>>;
export type AssertPullDevicesSidecarOptional = Expect<
  Equal<PullResponse['devices'], DeviceInfo[] | undefined>
>;
export type AssertPullHasMore = Expect<Equal<PullResponse['hasMore'], boolean>>;
export type AssertDeviceStoreIdNullable = Expect<Equal<DeviceInfo['storeId'], string | null>>;
export type AssertDeviceKindUnion = Expect<Equal<DeviceInfo['kind'], 'member' | 'system'>>;
export type AssertDeviceRevokedAtNullablePresent = Expect<
  Equal<DeviceInfo['revokedAt'], number | null>
>;

// --- error envelope (api/00 §6–7) ---
export type AssertErrorCodeOpenString = Expect<Equal<ErrorEnvelope['error']['code'], string>>;
export type AssertErrorMessageRequired = Expect<Equal<ErrorEnvelope['error']['message'], string>>;

// --- realtime (api/00 §12.1) ---
export type AssertWsMessageTypeUnion = Expect<Equal<WsMessage['type'], 'sync.poke'>>;

// --- bookkeeping (05 §2.3–2.4) ---
export type AssertSyncedAtNullNotUndefined = Expect<
  Equal<ClientBookkeeping['syncedAt'], number | null>
>;
export type AssertBookkeepingStatusIsSyncStatus = Expect<
  Equal<ClientBookkeeping['syncStatus'], SyncStatus>
>;
export type AssertServerSeqInteger = Expect<Equal<ServerBookkeeping['serverSeq'], number>>;
export type AssertClockSkewFlagBoolean = Expect<
  Equal<ServerBookkeeping['clockSkewFlagged'], boolean>
>;
