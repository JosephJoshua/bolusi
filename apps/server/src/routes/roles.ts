// Roles sub-router: the role editor (product-scope.md, "Managers, limits, approvals and roles"). Only
// the main owner (a tenant admin) makes, edits and deletes roles. Every store role but the owners' is
// editable; a made role starts as a copy of another and can be renamed or deleted while nobody holds
// it. What a role may do is set through the role editor's switches (@bolusi/modules role-abilities),
// and nothing else is taken. Online only, like every directory change: devices get the change with
// their next bundle.
import { abilitiesOf, normalizeRolePermissions, permissionsFor } from '@bolusi/modules';
import { CreateRoleReq, UpdateRoleReq } from '@bolusi/schemas';
import type { TenantDb } from '@bolusi/db-server';
import { Hono } from 'hono';

import { resolveActingUser } from '../auth/acting-user.js';
import { isTenantAdmin } from '../auth/permissions.js';
import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { ApiError } from '../errors.js';
import { appendAudit } from '../identity/audit.js';
import { PermissionDeniedError } from '../identity/denial-audit.js';
import { withIdentityErrors } from '../identity/errors.js';
import { DEFAULT_ROLES, PERM } from '../identity/permissions.js';
import { zJson } from '../middleware/validator-hook.js';
import { announceDirectoryChange } from '../realtime/announce.js';
import { createWithTenant, tenantIdFromContext } from '../tenant.js';
import { uuidv7 } from '../uuidv7.js';
import { rolesConferOwnerPowers } from './users.js';

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The preset roles' internal names: a made role never takes one, so its name is always its own. */
const RESERVED_NAMES = new Set(DEFAULT_ROLES.map((role) => role.key.toLowerCase()));

interface EditableRole {
  readonly id: string;
  readonly name: string;
  readonly isSystemDefault: boolean;
  readonly limited: boolean;
  readonly permissionIds: readonly string[];
}

/** Only the main owner edits roles; anyone else is denied, and the denial is on record. */
async function requireMainOwner(
  db: TenantDb,
  acting: {
    readonly userId: string;
    readonly tenantId: string;
    readonly deviceStoreId: string | null;
  },
): Promise<void> {
  if (await isTenantAdmin(db, acting.tenantId, acting.userId)) return;
  throw new PermissionDeniedError({
    actorUserId: acting.userId,
    permissionId: PERM.roleManage,
    scopeStoreId: acting.deviceStoreId,
    reason: 'restriction_violated',
  });
}

/**
 * A store role the editor may change: this business's (RLS hides another's, and a miss is a denial,
 * never a 404), and not an owner role, so nobody edits their way into or out of owner powers.
 */
async function loadEditableRole(db: TenantDb, roleId: string): Promise<EditableRole> {
  // Not an id at all: Postgres would fail on it rather than find nothing.
  if (!LOWERCASE_UUID.test(roleId)) throw new ApiError('PERMISSION_DENIED');
  const role = await db
    .selectFrom('roles')
    .select(['id', 'name', 'scopeType', 'isSystemDefault', 'limited'])
    .where('id', '=', roleId)
    .executeTakeFirst();
  if (role === undefined || role.scopeType !== 'store') throw new ApiError('PERMISSION_DENIED');
  if (await rolesConferOwnerPowers(db, [role])) throw new ApiError('PERMISSION_DENIED');
  const permissions = await db
    .selectFrom('rolePermissions')
    .select('permissionId')
    .where('roleId', '=', roleId)
    .execute();
  return {
    id: role.id,
    name: role.name,
    isSystemDefault: role.isSystemDefault,
    limited: role.limited,
    permissionIds: permissions.map((row) => row.permissionId).sort(),
  };
}

/** A made role's name: not a preset's, and not another role's here, whatever the case. */
async function requireFreeName(db: TenantDb, name: string, exceptRoleId: string | null) {
  const folded = name.toLowerCase();
  const taken =
    RESERVED_NAMES.has(folded) ||
    (await db.selectFrom('roles').select(['id', 'name']).execute()).some(
      (role) => role.id !== exceptRoleId && role.name.toLowerCase() === folded,
    );
  if (taken) throw new ApiError('VALIDATION_FAILED', { field: 'name', issue: 'taken' });
}

async function writePermissions(
  db: TenantDb,
  tenantId: string,
  roleId: string,
  permissionIds: readonly string[],
): Promise<void> {
  await db.deleteFrom('rolePermissions').where('roleId', '=', roleId).execute();
  if (permissionIds.length === 0) return;
  await db
    .insertInto('rolePermissions')
    .values(permissionIds.map((permissionId) => ({ roleId, permissionId, tenantId })))
    .execute();
}

export function createRolesRouter(deps: ServerDeps) {
  const withTenant = createWithTenant(deps.forTenant);

  return (
    new Hono<AppEnv>()
      // ---- POST /v1/roles: a new role, as a copy of another ----
      .post('/', zJson(CreateRoleReq), (c) =>
        withIdentityErrors(c, async () => {
          const body = c.req.valid('json');
          const t = deps.now();
          const tenantId = tenantIdFromContext(c);
          const roleId = uuidv7(t);

          await withTenant(c, async (db) => {
            const acting = await resolveActingUser(c, db);
            await requireMainOwner(db, acting);
            const source = await loadEditableRole(db, body.copyFromRoleId);
            await requireFreeName(db, body.name, null);
            // Copied through the switches, so a preset holding anything else starts clean.
            const permissionIds = permissionsFor(abilitiesOf(source.permissionIds));
            await db
              .insertInto('roles')
              .values({
                id: roleId,
                tenantId,
                name: body.name,
                scopeType: 'store',
                isSystemDefault: false,
                limited: source.limited,
                createdAt: BigInt(t),
              })
              .execute();
            await writePermissions(db, tenantId, roleId, permissionIds);
            await appendAudit(db, tenantId, {
              actorUserId: acting.userId,
              action: 'role.created',
              entityType: 'role',
              entityId: roleId,
              before: null,
              after: {
                name: body.name,
                copiedFrom: source.id,
                limited: source.limited,
                permissionIds,
              },
              at: t,
            });
          });

          announceDirectoryChange(deps, tenantId);
          return c.json({ roleId }, 201);
        }),
      )
      // ---- PATCH /v1/roles/:roleId: rename (made roles), switches, limited ----
      .patch('/:roleId', zJson(UpdateRoleReq), (c) =>
        withIdentityErrors(c, async () => {
          const body = c.req.valid('json');
          const roleId = c.req.param('roleId');
          const t = deps.now();
          const tenantId = tenantIdFromContext(c);

          await withTenant(c, async (db) => {
            const acting = await resolveActingUser(c, db);
            await requireMainOwner(db, acting);
            const role = await loadEditableRole(db, roleId);
            const changes: Record<string, unknown> = {};

            if (body.name !== undefined && body.name !== role.name) {
              // A preset's name is its copy key; only a made role has a name of its own.
              if (role.isSystemDefault) {
                throw new ApiError('VALIDATION_FAILED', { field: 'name', issue: 'preset' });
              }
              await requireFreeName(db, body.name, role.id);
              changes['name'] = body.name;
            }
            if (body.permissionIds !== undefined) {
              const permissionIds = normalizeRolePermissions(body.permissionIds);
              if (permissionIds === null) {
                throw new ApiError('VALIDATION_FAILED', {
                  field: 'permissionIds',
                  issue: 'not a list the role editor makes',
                });
              }
              if (permissionIds.join() !== role.permissionIds.join()) {
                changes['permissionIds'] = permissionIds;
              }
            }
            if (body.limited !== undefined && body.limited !== role.limited) {
              changes['limited'] = body.limited;
            }
            if (Object.keys(changes).length === 0) return;

            if (changes['name'] !== undefined || changes['limited'] !== undefined) {
              await db
                .updateTable('roles')
                .set({
                  ...(changes['name'] === undefined ? {} : { name: changes['name'] as string }),
                  ...(changes['limited'] === undefined
                    ? {}
                    : { limited: changes['limited'] as boolean }),
                })
                .where('id', '=', role.id)
                .execute();
            }
            if (changes['permissionIds'] !== undefined) {
              await writePermissions(
                db,
                tenantId,
                role.id,
                changes['permissionIds'] as readonly string[],
              );
            }
            await appendAudit(db, tenantId, {
              actorUserId: acting.userId,
              action: 'role.updated',
              entityType: 'role',
              entityId: role.id,
              before: Object.fromEntries(
                Object.keys(changes).map((key) => [key, role[key as keyof EditableRole]]),
              ),
              after: changes,
              at: t,
            });
          });

          announceDirectoryChange(deps, tenantId);
          return c.json({ roleId });
        }),
      )
      // ---- DELETE /v1/roles/:roleId: a made role nobody holds ----
      .delete('/:roleId', (c) =>
        withIdentityErrors(c, async () => {
          const roleId = c.req.param('roleId');
          const t = deps.now();
          const tenantId = tenantIdFromContext(c);

          await withTenant(c, async (db) => {
            const acting = await resolveActingUser(c, db);
            await requireMainOwner(db, acting);
            const role = await loadEditableRole(db, roleId);
            if (role.isSystemDefault) {
              throw new ApiError('VALIDATION_FAILED', { field: 'roleId', issue: 'preset' });
            }
            const held = await db
              .selectFrom('userRoles')
              .select('userId')
              .where('roleId', '=', role.id)
              .executeTakeFirst();
            if (held !== undefined) {
              throw new ApiError('VALIDATION_FAILED', { field: 'roleId', issue: 'inUse' });
            }
            await db.deleteFrom('roleLimits').where('roleId', '=', role.id).execute();
            await db.deleteFrom('rolePermissions').where('roleId', '=', role.id).execute();
            await db.deleteFrom('roles').where('id', '=', role.id).execute();
            await appendAudit(db, tenantId, {
              actorUserId: acting.userId,
              action: 'role.deleted',
              entityType: 'role',
              entityId: role.id,
              before: { name: role.name, limited: role.limited, permissionIds: role.permissionIds },
              after: null,
              at: t,
            });
          });

          announceDirectoryChange(deps, tenantId);
          return c.json({ roleId });
        }),
      )
  );
}
