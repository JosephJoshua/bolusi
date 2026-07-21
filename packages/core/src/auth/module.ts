// The `auth` module manifest (04 §1; api/02-auth §6.2) — the piece that was specified, half-built,
// and orphaned: the ops were emitted, chained, signed, and synced, but no manifest wired an applier
// to them, so `auth_sessions` / `pin_lockout_events` / `auth_permission_denials` stayed empty and
// every query against them returned nothing. Nothing failed, which is why nobody noticed (task 14
// found it and reported it rather than shipping its own surface green). This closes it.
//
// This is the module `SERVER_MODULES` (apps/server/src/deps.ts) — and, out of this task's scope, the
// client `CLIENT_MODULES` (apps/mobile) — must carry. Registering it lights up BOTH the op-payload
// validators and the projection appliers from ONE list (task 49's seam), so the server can never
// validate a type it cannot fold, or fold one it never validated.
//
// It declares no `migrations`: the DDL for the three tables is owned by 10-db §549+ and already
// shipped on both engines (task 04). Re-declaring it here would be a second source of truth about a
// schema that exists (CLAUDE.md §2.8); the T-8 applier-conformance runner creates the tables it needs
// from 10-db's DDL instead.
//
// ── ONE OP REGISTRY, NOT TWO (CLAUDE.md §2.8) ─────────────────────────────────────────────────
//
// Task 14 shipped `authOperationRegistry` (op type → schemaVersion/scope), consumed by the command
// runtime's `ctx.op()`. This manifest does NOT fork a second version list: every declaration below
// SOURCES its `schemaVersion` from that registry (`schemaVersionOf`), and a startup guard asserts the
// manifest's op-type set EQUALS `authOperationRegistry.types()`. So a ninth auth op type added to the
// registry with no applier here is an IMPORT-TIME failure — the handoff-ring that left this unbuilt
// cannot recur silently.
import { z } from 'zod';

import type { PermissionDeclaration } from '../authz/registry.js';
import {
  defineModule,
  type ModuleDefinition,
  type ModuleManifest,
  type OperationDeclaration,
} from '../module/define-module.js';
import type { ProjectionApplier } from '../projection/manifest.js';
import {
  pinLockedOutApplier,
  pinLockoutClearedApplier,
  pinLockoutEventsTable,
} from './projections/lockout-events.js';
import {
  authPermissionDenialsTable,
  permissionDeniedApplier,
  permissionDeniedPayload,
} from './projections/permission-denials.js';
import {
  authSessionsTable,
  sessionEndedApplier,
  userSwitchedApplier,
} from './projections/sessions.js';
import { AUTH_MODULE_ID, AUTH_OP, AUTH_PERMISSION, authOperationRegistry } from './operations.js';
import { listPermissionDenialsQuery } from './queries.js';
import type { AuthDatabase } from './schema.js';

// ── payload schemas (04 §3 — all `.strict()`) ─────────────────────────────────────────────────────
//
// No op payload ever carries verifier or hash material (api/02-auth §6.2, D11): a PIN hash in an
// immutable, forever-replicated log is an unrotatable secret. `verifierRef` NAMES the new verifier
// record; it carries no key material.

/** `auth.device_enrolled` (api/02-auth §6.2): the genesis op's payload. */
const deviceEnrolledPayload = z
  .object({
    storeId: z.string().min(1),
    deviceName: z.string().min(1),
    devicePublicKeyB64: z.string().min(1),
  })
  .strict();

/** `auth.user_switched` (api/02-auth §6.2). Present-and-null on a device's first switch (05 §3). */
const userSwitchedPayload = z
  .object({
    previousSessionId: z.string().min(1).nullable(),
    previousUserId: z.string().min(1).nullable(),
  })
  .strict();

/** `auth.session_ended` (api/02-auth §6.2). */
const sessionEndedPayload = z
  .object({ reason: z.enum(['switch', 'idle_lock', 'manual_lock']) })
  .strict();

/** `auth.pin_changed` / `auth.pin_reset` (api/02-auth §6.2) — same shape, different emitter. */
const pinCredentialPayload = z
  .object({ targetUserId: z.string().min(1), verifierRef: z.string().min(1) })
  .strict();

/** `auth.pin_locked_out` (api/02-auth §6.2/§6.5). */
const pinLockedOutPayload = z
  .object({
    consecutiveFailures: z.number().int(),
    windowStartedAt: z.number().int(),
  })
  .strict();

/** `auth.pin_lockout_cleared` (api/02-auth §6.2): a historical fact with no payload fields. */
const pinLockoutClearedPayload = z.object({}).strict();

// ── the no-projection fold ─────────────────────────────────────────────────────────────────────
//
// THREE auth op types carry no projection table, and that is deliberate, not a gap (the T-14
// denominator: every op type in `authOperationRegistry` has an applier OR a stated reason it does
// not project — stated here):
//   auth.device_enrolled  — the enrolled device is a DIRECTORY fact (server-owned bundle tables,
//                           api/02-auth §4), never a device-side projection; the genesis op exists
//                           to root the hash chain (seq 1), not to fold a row.
//   auth.pin_changed      — the verifier lives in the `user_pin_verifiers` DIRECTORY table, written
//   auth.pin_reset          from the bundle + the §6.6 local write, NEVER from an op (api/02-auth
//                           §6.2: "`user_pin_verifiers` is NOT a projection"). The op is the audit
//                           trail of the credential change; its readable evidence a user is locked
//                           out lands in `pin_lockout_events`, not from these.
//
// `defineModule` still requires an `apply` per type, so these fold through this total no-op — which
// the T-8 conformance suite folds too, asserting both engines agree it wrote nothing.
const noProjection: ProjectionApplier<AuthDatabase> = async () => {};

/** Source `schemaVersion` from task 14's registry — never a second literal (CLAUDE.md §2.8). */
function schemaVersionOf(type: string): number {
  const version = authOperationRegistry.schemaVersionFor(type);
  if (version === undefined) {
    throw new Error(
      `auth manifest declares op type ${JSON.stringify(type)}, which authOperationRegistry does not — the manifest and the runtime op registry must agree on the auth op set (CLAUDE.md §2.8).`,
    );
  }
  return version;
}

/** The eight auth op declarations (04 §3), keyed by op type — the FULL api/02-auth §6.2 set. */
export const authOperations: Readonly<Record<string, OperationDeclaration<AuthDatabase>>> = {
  [AUTH_OP.deviceEnrolled]: {
    schemaVersion: schemaVersionOf(AUTH_OP.deviceEnrolled),
    payload: deviceEnrolledPayload,
    reversal:
      'Not reversible; device retirement is server-side revocation (api/02-auth §7), audited on the control plane. The genesis op is a permanent chain root.',
    apply: noProjection,
  },
  [AUTH_OP.userSwitched]: {
    schemaVersion: schemaVersionOf(AUTH_OP.userSwitched),
    payload: userSwitchedPayload,
    reversal:
      'Session records are historical facts; a mistaken switch is corrected by the next auth.user_switched (api/02-auth §6.2).',
    apply: userSwitchedApplier,
  },
  [AUTH_OP.sessionEnded]: {
    schemaVersion: schemaVersionOf(AUTH_OP.sessionEnded),
    payload: sessionEndedPayload,
    reversal: 'Historical fact; not reversible (api/02-auth §6.2).',
    apply: sessionEndedApplier,
  },
  [AUTH_OP.pinChanged]: {
    schemaVersion: schemaVersionOf(AUTH_OP.pinChanged),
    payload: pinCredentialPayload,
    reversal:
      'Superseded by a later auth.pin_changed/auth.pin_reset on the same entityId (canonical-order LWW audit trail, api/02-auth §6.2).',
    apply: noProjection,
  },
  [AUTH_OP.pinReset]: {
    schemaVersion: schemaVersionOf(AUTH_OP.pinReset),
    payload: pinCredentialPayload,
    reversal:
      'Superseded by a later auth.pin_changed/auth.pin_reset on the same entityId (api/02-auth §6.2).',
    apply: noProjection,
  },
  [AUTH_OP.pinLockedOut]: {
    schemaVersion: schemaVersionOf(AUTH_OP.pinLockedOut),
    payload: pinLockedOutPayload,
    reversal:
      'Cleared by auth.pin_lockout_cleared or any later auth.pin_reset on the same entityId (api/02-auth §6.2/§6.5).',
    apply: pinLockedOutApplier,
  },
  [AUTH_OP.pinLockoutCleared]: {
    schemaVersion: schemaVersionOf(AUTH_OP.pinLockoutCleared),
    payload: pinLockoutClearedPayload,
    reversal: 'Historical fact; a re-lock is a new auth.pin_locked_out (api/02-auth §6.2).',
    apply: pinLockoutClearedApplier,
  },
  [AUTH_OP.permissionDenied]: {
    schemaVersion: schemaVersionOf(AUTH_OP.permissionDenied),
    payload: permissionDeniedPayload,
    reversal: 'Historical fact; not reversible (02-permissions §7).',
    apply: permissionDeniedApplier,
  },
};

/**
 * The T-14 denominator, asserted at import: every op type the runtime registry knows has an applier
 * declared here, and vice versa. This is the guard that makes the handoff-ring impossible to re-open
 * silently — a registry type with no manifest applier is what left this whole surface unbuilt.
 */
function assertAuthOpCoverage(): void {
  const declared = Object.keys(authOperations).sort();
  const registered = authOperationRegistry.types();
  const mismatch =
    declared.length !== registered.length || declared.some((type, i) => type !== registered[i]);
  if (mismatch) {
    throw new Error(
      `auth manifest op types [${declared.join(', ')}] do not match authOperationRegistry [${registered.join(', ')}] — every auth op type must declare an applier (T-14; the handoff-ring this task closed).`,
    );
  }
}

assertAuthOpCoverage();

// ── permissions (02-permissions §11.1, verbatim scopes / isDangerous / canonical EN) ─────────────
const store = (isDangerous: boolean, description: string): PermissionDeclaration => ({
  scope: 'store',
  isDangerous,
  description,
});
const tenant = (isDangerous: boolean, description: string): PermissionDeclaration => ({
  scope: 'tenant',
  isDangerous,
  description,
});

/** The manifest as authored (04 §1). */
export const authModuleManifest = {
  id: AUTH_MODULE_ID,

  operations: authOperations,

  projections: {
    tables: {
      auth_sessions: authSessionsTable,
      pin_lockout_events: pinLockoutEventsTable,
      auth_permission_denials: authPermissionDenialsTable,
    },
    // No `migrations` — see the file header.
  },

  /** The auth permission registry (02-permissions §11.1), the canonical home for these ids. */
  permissions: {
    [AUTH_PERMISSION.userCreate]: store(false, 'Can create employee accounts for the store.'),
    [AUTH_PERMISSION.userEdit]: store(
      false,
      "Can edit an employee's name, photo, and store membership.",
    ),
    [AUTH_PERMISSION.userDeactivate]: store(
      true,
      "Can deactivate an employee's account, removing their access everywhere. Their history is kept.",
    ),
    [AUTH_PERMISSION.userResetPin]: store(
      true,
      "Can reset another employee's PIN. Whoever holds this can take over that person's identity until they change it.",
    ),
    [AUTH_PERMISSION.pinChange]: store(false, 'Can change their own PIN.'),
    [AUTH_PERMISSION.pinUnlock]: store(
      false,
      "Can clear an employee's PIN lockout so they can try again.",
    ),
    [AUTH_PERMISSION.roleManage]: tenant(
      true,
      'Can create, rename, edit, and delete roles, and give them to employees or take them away.',
    ),
    [AUTH_PERMISSION.deviceEnroll]: store(
      true,
      'Can approve a new device for the store. An approved device can record and sign business actions.',
    ),
    [AUTH_PERMISSION.deviceRevoke]: store(
      true,
      'Can block a device (lost, stolen, retired). Anything not yet synced from it will be rejected.',
    ),
    [AUTH_PERMISSION.deviceRead]: store(
      false,
      "Can see the store's devices, who is enrolled on them, and when each last synced.",
    ),
    [AUTH_PERMISSION.tenantConfigure]: tenant(
      true,
      'Can change business-wide settings that apply to every store.',
    ),
    [AUTH_PERMISSION.auditView]: store(
      false,
      'Can view the audit trail: denied attempts, PIN resets, user switches, and device events.',
    ),
  },

  queries: {
    listPermissionDenials: listPermissionDenialsQuery,
  },
} as const satisfies ModuleManifest<AuthDatabase>;

/**
 * The defined `auth` module — validated at IMPORT time (04 §3/§4.4). Living INSIDE core means a
 * malformed manifest is a startup failure for every consumer, not a per-consumer obligation.
 */
export const authModule: ModuleDefinition<AuthDatabase, typeof authModuleManifest> = defineModule<
  AuthDatabase,
  typeof authModuleManifest
>(authModuleManifest);
