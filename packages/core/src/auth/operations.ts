// The `auth` module's operation registry (api/02-auth §6.2) — op type → declared `schemaVersion`.
//
// The command runtime resolves an op's version from an `OperationRegistry` (runtime/execute.ts):
// the PIN commands (`auth.changePin` etc.) emit `auth.pin_changed`/`auth.pin_reset`/
// `auth.pin_lockout_cleared` through `ctx.op()`, which fails closed on an unregistered type. This is
// that registry for the auth module. It is the FIRST and only auth op registry in the codebase — not
// a second copy of one (CLAUDE.md §2.8); the server transcribed the PERMISSION registry as a
// stopgap (task 33), but never the op registry, which has no other home.
//
// The runtime-emitted auth ops (`auth.device_enrolled`, `auth.user_switched`, `auth.session_ended`,
// `auth.pin_locked_out`, `auth.permission_denied`) are appended via `emitRuntimeOp`, which does not
// yet consult this registry (a stopgap flagged in runtime/execute.ts for tasks 13/25). They are
// declared here anyway so the auth op set is COMPLETE — when that stopgap is removed the versions
// already agree, and a sweep over auth op types has its full denominator (testing-guide T-14).
import type { OperationRegistry } from '../module/registry.js';

/** The `auth` module id (04 §1) — prefixes every op type and permission below. */
export const AUTH_MODULE_ID = 'auth';

/** The complete `auth` op-type set (api/02-auth §6.2). */
export const AUTH_OP = {
  deviceEnrolled: 'auth.device_enrolled',
  userSwitched: 'auth.user_switched',
  sessionEnded: 'auth.session_ended',
  pinChanged: 'auth.pin_changed',
  pinReset: 'auth.pin_reset',
  pinLockedOut: 'auth.pin_locked_out',
  pinLockoutCleared: 'auth.pin_lockout_cleared',
  permissionDenied: 'auth.permission_denied',
} as const;

/** The entity types the auth ops carry (api/02-auth §6.2). */
export const AUTH_ENTITY = {
  device: 'device',
  authSession: 'auth_session',
  userCredential: 'user_credential',
  permissionDenial: 'permission_denial',
} as const;

/** The permission ids the auth commands require (02-permissions §11.1). */
export const AUTH_PERMISSION = {
  pinChange: 'auth.pin_change',
  userResetPin: 'auth.user_reset_pin',
  pinUnlock: 'auth.pin_unlock',
  deviceEnroll: 'auth.device_enroll',
} as const;

/** The `main_owner` role id (02-permissions §10) — the privileged-target rule pivots on it (§6.6). */
export const MAIN_OWNER_ROLE_ID = 'main_owner';

/** Every auth op type declares `schemaVersion: 1` in v0. */
const AUTH_OP_SCHEMA_VERSIONS: ReadonlyMap<string, number> = new Map(
  Object.values(AUTH_OP).map((type) => [type, 1] as const),
);

/** The `auth` module's operation registry (04 §3) — the runtime's `operations` option. */
export const authOperationRegistry: OperationRegistry = {
  schemaVersionFor: (type) => AUTH_OP_SCHEMA_VERSIONS.get(type),
  types: () => [...AUTH_OP_SCHEMA_VERSIONS.keys()].sort(),
  get size() {
    return AUTH_OP_SCHEMA_VERSIONS.size;
  },
};
