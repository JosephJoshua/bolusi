// @bolusi/core authz (02-permissions): the permission registry (§3), the normative fail-closed
// evaluation algorithm (§5), offline evaluation against the client directory mirrors with
// event-driven memo invalidation (§6), denial-op emission with the 5-minute throttle (§7), and the
// permission-set-change hook registry (§8.4). Platform-free; the directory is read through an
// injected Kysely handle and the clock/emission are injected ports (08 §3.2).
//
// The command/query runtime's `ctx.requirePermission` (04 §5.1) — the single enforcement point
// (§4) — is task 10 and consumes these as ports.
export {
  assemblePermissionRegistry,
  collectPermissionReferences,
  PermissionRegistry,
  PermissionRegistryError,
  PERMISSION_ID_PATTERN,
  type ModulePermissionManifest,
  type PermissionDeclaration,
  type PermissionEntry,
  type PermissionReference,
  type PermissionRequiringSurface,
  type PermissionScope,
} from './registry.js';

export {
  computeEffectiveSet,
  DENIAL_REASONS,
  evaluatePermission,
  parsePermissionIds,
  type DenialReason,
  type EffectiveSet,
  type EffectiveSetLookup,
  type PermissionQuery,
  type PermissionResult,
} from './evaluate.js';

export {
  createDirectorySource,
  emptyDirectorySnapshot,
  loadDirectorySnapshot,
  TENANT_ID_META_KEY,
  type DirectoryGrant,
  type DirectoryRole,
  type DirectorySnapshot,
  type DirectorySource,
  type DirectoryUser,
} from './directory.js';

export { PermissionEvaluator, type PermissionEvaluatorStats } from './memo.js';

export {
  DenialEmitter,
  DENIAL_THROTTLE_WINDOW_MS,
  isPermissionDeniedPayload,
  PERMISSION_DENIAL_ENTITY_TYPE,
  PERMISSION_DENIED_OP_TYPE,
  type DenialAttempt,
  type DenialEmissionContext,
  type DenialEmissionPort,
  type DenialEmitterOptions,
  type DenialSurface,
  type PermissionDeniedPayload,
} from './denials.js';

export {
  permissionSetDelta,
  PermissionInvalidationRegistry,
  type PermissionSetChangeHook,
} from './invalidation.js';
