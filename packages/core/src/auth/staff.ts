/**
 * Staff management (owner decision 2026-10-27): an owner adds the people of their store, renames
 * them, changes their roles, and deactivates or reactivates them.
 *
 * ONLINE ONLY. The server owns who works here (it checks the owner's rights, keeps the last main
 * owner, and tells every device), so each change is a call through {@link StaffAdminPort}, and this
 * device sees the result when its next bundle refresh rewrites the directory mirrors. Nothing here
 * writes the mirrors itself.
 *
 * Platform-free so the phone and the counter PC offer the same choices. The server enforces the same
 * rules again (apps/server routes/users.ts): these only decide what to offer.
 */
import { sql, type Kysely } from 'kysely';

import { parseLimitAmounts, type LimitAmounts } from '../authz/limits.js';
import { STORE_ID_META_KEY } from '../authz/directory.js';
import { AUTH_PERMISSION } from './operations.js';
import { holdsMainOwnerRole } from './repo.js';

/** The preset roles an owner picks from, in the order they are offered. Made roles follow. */
export const STAFF_ROLE_KEYS = ['cashier', 'technician', 'manager', 'store_owner'] as const;
export type StaffRoleKey = (typeof STAFF_ROLE_KEYS)[number];

export interface StaffRole {
  readonly id: string;
  /** `roles_directory.name`: a preset's key, or a made role's own name (`translateRoleKey`). */
  readonly key: string;
  /** Made in the role editor (not a preset): it can be renamed, and deleted while nobody holds it. */
  readonly custom: boolean;
  /** What the role may do, as permission ids. */
  readonly permissionIds: readonly string[];
  /** An owner role (power over other accounts): only a main owner may hand it out. */
  readonly ownerRole: boolean;
  /** A limited role's amounts at this store (unreadable amounts read as Rp 0); null when free of
   *  limits. */
  readonly limits: LimitAmounts | null;
}

export interface StaffMember {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  /** Every role the person holds here, by `roles_directory.name` (`role.<key>.name` copy). */
  readonly roleKeys: readonly string[];
  /** The ids of those roles, for the edit form's starting choice. */
  readonly roleIds: readonly string[];
  /** Holds an owner role (see {@link OWNER_POWER_PERMISSIONS}). */
  readonly owner: boolean;
  /** Has a PIN on this device; a new person has none until "PIN karyawan" makes one. */
  readonly hasPin: boolean;
}

export interface StaffDirectory {
  /** The pickable roles this tenant has: the presets in {@link STAFF_ROLE_KEYS} order, then the
   *  made ones by name. */
  readonly roles: readonly StaffRole[];
  /** Everyone in this store's directory, active first, then by name. */
  readonly members: readonly StaffMember[];
}

interface RoleRow {
  readonly id: string;
  readonly name: string;
  readonly scopeType: string;
  readonly isSystemDefault: number | boolean;
  readonly permissionIds: string | readonly unknown[];
  readonly limits: string | null;
}

function permissionIdsOf(role: Pick<RoleRow, 'permissionIds'>): readonly string[] {
  const parsed: unknown =
    typeof role.permissionIds === 'string' ? JSON.parse(role.permissionIds) : role.permissionIds;
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * The permissions that give power over other people's accounts. A role holding any of them, or any
 * tenant-wide role, is an OWNER role: only a main owner may grant it or manage its holders. The
 * server applies the same list (routes/users.ts), so a custom role cannot slip a store owner's
 * peer past the rule by leaving out `user_create`.
 */
export const OWNER_POWER_PERMISSIONS: readonly string[] = [
  AUTH_PERMISSION.userCreate,
  AUTH_PERMISSION.userEdit,
  AUTH_PERMISSION.userDeactivate,
  AUTH_PERMISSION.userResetPin,
  AUTH_PERMISSION.roleManage,
];

/** Whether a role is an owner role: tenant-wide, or holding power over other people's accounts. */
export function isOwnerRoleOf(scopeType: string, permissionIds: readonly string[]): boolean {
  if (scopeType === 'tenant') return true;
  return permissionIds.some((id) => OWNER_POWER_PERMISSIONS.includes(id));
}

function isOwnerRole(role: Pick<RoleRow, 'scopeType' | 'permissionIds'>): boolean {
  return isOwnerRoleOf(role.scopeType, permissionIdsOf(role));
}

function staffRoleOf(row: RoleRow): StaffRole {
  return {
    id: row.id,
    key: row.name,
    custom: !row.isSystemDefault,
    permissionIds: permissionIdsOf(row),
    ownerRole: isOwnerRole(row),
    limits: limitsOf(row.limits),
  };
}

/**
 * Whether this person holds an owner role in this device's directory: tenant-wide, at this store,
 * or at another store (the bundle carries owner-role grants at every store, since the server counts
 * them all).
 */
export async function holdsOwnerRole<DB>(db: Kysely<DB>, userId: string): Promise<boolean> {
  const held = await sql<Pick<RoleRow, 'scopeType' | 'permissionIds'>>`
    SELECT rd.scope_type AS "scopeType", rd.permission_ids AS "permissionIds"
    FROM user_roles_directory urd JOIN roles_directory rd ON rd.id = urd.role_id
    WHERE urd.user_id = ${userId}
  `.execute(db);
  return held.rows.some(isOwnerRole);
}

/**
 * May this actor reset or unlock this person's PIN as far as owner powers go? An owner's PIN is the
 * main owner's to manage: handing it over hands over the account, so a store owner manages the
 * PINs of cashiers, technicians and managers, never a peer owner's or the main owner's. The PIN
 * commands check it before they run, the screens use it to decide what to offer, and the server
 * applies the same rule (apps/server auth/permissions.ts `mayManageOwnerPin`).
 */
export async function mayManageOwnerPin<DB>(
  db: Kysely<DB>,
  actorUserId: string,
  targetUserId: string,
): Promise<boolean> {
  return !(await holdsOwnerRole(db, targetUserId)) || holdsMainOwnerRole(db, actorUserId);
}

function isStaffRoleKey(name: string): name is StaffRoleKey {
  return (STAFF_ROLE_KEYS as readonly string[]).includes(name);
}

/** Read the staff list and the pickable roles from the bundle's directory mirrors. */
export async function readStaffDirectory<DB>(db: Kysely<DB>): Promise<StaffDirectory> {
  const [roleRows, userRows, grantRows] = await Promise.all([
    sql<RoleRow>`
      SELECT id, name, scope_type AS "scopeType", is_system_default AS "isSystemDefault",
        permission_ids AS "permissionIds", limits
      FROM roles_directory
    `.execute(db),
    sql<{ id: string; name: string; status: string; hasPin: number }>`
      SELECT u.id, u.name, u.status, (v.user_id IS NOT NULL) AS "hasPin"
      FROM users_directory u LEFT JOIN user_pin_verifiers v ON v.user_id = u.id
    `.execute(db),
    // `here`: a grant at this store or tenant-wide. The bundle also carries owner-role grants at
    // other stores, which make the person an owner but are not a role they hold here.
    sql<{ userId: string; roleId: string; here: number }>`
      SELECT user_id AS "userId", role_id AS "roleId",
        MAX(store_id IS NULL
          OR store_id = COALESCE((SELECT value FROM meta_kv WHERE key = ${STORE_ID_META_KEY}), store_id)) AS "here"
      FROM user_roles_directory GROUP BY user_id, role_id
    `.execute(db),
  ]);
  const roleById = new Map(roleRows.rows.map((role) => [role.id, role]));

  const presets = STAFF_ROLE_KEYS.flatMap((key) => {
    const row = roleRows.rows.find((role) => role.isSystemDefault && role.name === key);
    return row === undefined ? [] : [staffRoleOf(row)];
  });
  const made = roleRows.rows
    .filter((role) => !role.isSystemDefault && role.scopeType === 'store')
    .map(staffRoleOf)
    .sort((a, b) => a.key.localeCompare(b.key, 'id'));
  const roles = [...presets, ...made];

  const members = userRows.rows.map((user): StaffMember => {
    const roleOf = (grant: { roleId: string }) => roleById.get(grant.roleId);
    const grants = grantRows.rows.filter((grant) => grant.userId === user.id);
    const held = grants
      .filter((grant) => Boolean(grant.here))
      .map(roleOf)
      .filter((role): role is RoleRow => role !== undefined)
      .sort((a, b) => roleRank(a.name) - roleRank(b.name));
    return {
      id: user.id,
      name: user.name,
      active: user.status === 'active',
      roleKeys: held.map((role) => role.name),
      roleIds: held.map((role) => role.id),
      // An owner at any store is an owner here too, as the server judges it.
      owner: grants.some((grant) => {
        const role = roleOf(grant);
        return role !== undefined && isOwnerRole(role);
      }),
      hasPin: Boolean(user.hasPin),
    };
  });
  members.sort((a, b) =>
    a.active !== b.active ? (a.active ? -1 : 1) : a.name.localeCompare(b.name),
  );
  return { roles, members };
}

/** The mirror's JSON, read the way the authorizer reads it: a corrupt row stays limited, at Rp 0. */
function limitsOf(json: string | null): LimitAmounts | null {
  if (json === null) return null;
  try {
    return parseLimitAmounts(JSON.parse(json));
  } catch {
    return parseLimitAmounts(null);
  }
}

/** Owners first, then the staff roles in offer order, then anything custom. */
function roleRank(name: string): number {
  if (name === 'main_owner') return -2;
  if (name === 'store_owner') return -1;
  return isStaffRoleKey(name) ? STAFF_ROLE_KEYS.indexOf(name) : STAFF_ROLE_KEYS.length;
}

/** Who is managing staff, as far as what to offer goes. */
export interface StaffActor {
  readonly userId: string;
  /** A tenant admin (the main owner): may make and manage owners. */
  readonly tenantAdmin: boolean;
}

/** The roles this actor may hand out: owner roles only for a main owner. */
export function grantableRoles(
  roles: readonly StaffRole[],
  actor: StaffActor,
): readonly StaffRole[] {
  return roles.filter((role) => actor.tenantAdmin || !role.ownerRole);
}

/**
 * May this actor change this person? Not themselves (their own PIN is under "Ganti PIN", and an owner
 * who removes their own role or account locks themselves out), and an owner only for a main owner.
 */
export function canManageMember(member: StaffMember, actor: StaffActor): boolean {
  return member.id !== actor.userId && (actor.tenantAdmin || !member.owner);
}

/**
 * The limited roles whose amounts this actor may set here: never one they hold themselves (nobody
 * raises their own limit; the server refuses it too).
 */
export function settableLimitRoles(
  directory: StaffDirectory,
  actor: StaffActor,
): readonly StaffRole[] {
  const held = directory.members.find((member) => member.id === actor.userId)?.roleIds ?? [];
  return directory.roles.filter((role) => role.limits !== null && !held.includes(role.id));
}

/** The longest name the server takes (`CreateUserReq.name`). */
export const STAFF_NAME_MAX = 64;

export interface StaffDraft {
  readonly name: string;
  readonly roleIds: readonly string[];
}

export type StaffDraftProblem = 'nameMissing' | 'nameTooLong' | 'nameTaken' | 'roleMissing';

/**
 * What is wrong with a draft before it is sent, or null. Names are compared trimmed and without
 * case among everyone else here, active or not: two "Rina"s on the switcher cannot be told apart.
 */
export function staffDraftProblem(
  draft: StaffDraft,
  members: readonly StaffMember[],
  editingId: string | null,
): StaffDraftProblem | null {
  const name = draft.name.trim();
  if (name === '') return 'nameMissing';
  if (name.length > STAFF_NAME_MAX) return 'nameTooLong';
  const folded = name.toLocaleLowerCase('id');
  if (
    members.some(
      (member) => member.id !== editingId && member.name.trim().toLocaleLowerCase('id') === folded,
    )
  ) {
    return 'nameTaken';
  }
  if (draft.roleIds.length === 0) return 'roleMissing';
  return null;
}

/** Why a staff change did not happen, as the screens explain it. */
export type StaffAdminFailure =
  /** No connection to the server: nothing changed, try again online. */
  | 'offline'
  /** The server refused this owner (their rights changed, or the person is an owner). */
  | 'denied'
  /** It would leave the business with no main owner. */
  | 'lastOwner'
  /** Too many staff changes today. */
  | 'rateLimited'
  | 'unexpected';

export class StaffAdminError extends Error {
  constructor(readonly reason: StaffAdminFailure) {
    super(`staff change failed: ${reason}`);
    this.name = 'StaffAdminError';
  }
}

/** The failure reason of anything a staff call threw. */
export function staffAdminFailure(error: unknown): StaffAdminFailure {
  return error instanceof StaffAdminError ? error.reason : 'unexpected';
}

/**
 * The server calls, made as `actingUserId` from this device (api/02-auth §5.4). Each resolves once
 * the server applied the change and REJECTS with a {@link StaffAdminError}.
 */
export interface StaffAdminPort {
  create(input: {
    readonly actingUserId: string;
    readonly storeId: string;
    readonly name: string;
    readonly roleIds: readonly string[];
  }): Promise<{ readonly userId: string }>;
  update(input: {
    readonly actingUserId: string;
    readonly userId: string;
    readonly name?: string | undefined;
    readonly roleIds?: readonly string[] | undefined;
  }): Promise<void>;
  setActive(input: {
    readonly actingUserId: string;
    readonly userId: string;
    readonly active: boolean;
  }): Promise<void>;
  /** Set how far a limited role may go at this store, per servisan. */
  setLimits(input: {
    readonly actingUserId: string;
    readonly storeId: string;
    readonly roleId: string;
    readonly limits: LimitAmounts;
  }): Promise<void>;
  /** Rename the device this runs on (an owner who may register devices here). */
  renameDevice(input: { readonly actingUserId: string; readonly name: string }): Promise<void>;
  /** Make a role (the main owner), starting as a copy of another. */
  createRole(input: {
    readonly actingUserId: string;
    readonly name: string;
    readonly copyFromRoleId: string;
  }): Promise<{ readonly roleId: string }>;
  /** Change a role's name (made roles only), what it may do, or whether it is limited. */
  updateRole(input: {
    readonly actingUserId: string;
    readonly roleId: string;
    readonly name?: string | undefined;
    readonly permissionIds?: readonly string[] | undefined;
    readonly limited?: boolean | undefined;
  }): Promise<void>;
  /** Delete a made role nobody holds. */
  deleteRole(input: { readonly actingUserId: string; readonly roleId: string }): Promise<void>;
}
