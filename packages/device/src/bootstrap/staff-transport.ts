// The fetch adapter for the owner's staff changes (api/02-auth §5.4; owner decision 2026-10-27):
// `POST /v1/users`, `PATCH /v1/users/:id`, `POST /v1/users/:id/deactivate|reactivate`, a store's
// limits for a limited role (`PUT /v1/role-limits`), the role editor (`/v1/roles`) and this device's
// name (`PATCH /v1/devices/me`), each made as the signed-in owner (`X-Acting-User`) on this device's
// bearer, the same shape as `pin-verifier-transport.ts`. The server is the authority; this only
// translates its answer into the closed `StaffAdminFailure` set the screens explain.
//
// No queue: staff changes are online only, so a network fault is `offline` right away and the owner
// tries again, rather than a change that lands hours later on a device they no longer watch.
import { StaffAdminError, type StaffAdminFailure, type StaffAdminPort } from '@bolusi/core';

export interface StaffTransportConfig {
  /** Base URL of the server, no trailing slash. */
  readonly baseUrl: string;
  /** The `bdt_` device token, read at call time, never cached. */
  readonly deviceToken: () => Promise<string | null>;
  /** Injected for tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

export function createFetchStaffAdmin(config: StaffTransportConfig): StaffAdminPort {
  const doFetch = config.fetchImpl ?? fetch;

  const call = async (
    actingUserId: string,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const token = await config.deviceToken();
    if (token === null) throw new StaffAdminError('unexpected');
    let response: Response;
    try {
      response = await doFetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Acting-User': actingUserId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // fetch rejects only when no answer came back: no connection, DNS, a dropped socket.
      throw new StaffAdminError('offline');
    }
    if (!response.ok) throw new StaffAdminError(await failureOf(response));
    return response.json().catch(() => null);
  };

  return {
    async create({ actingUserId, storeId, name, roleIds }) {
      const json = (await call(actingUserId, 'POST', '/v1/users', {
        name,
        // Staff sign in with a PIN on store devices only (decision 4): no login, no password.
        loginIdentifier: null,
        password: null,
        storeIds: [storeId],
        roleIds,
        // The PIN is made afterwards, by the person, through "PIN karyawan" (decision 3).
        pinVerifier: null,
      })) as { readonly userId?: unknown } | null;
      if (typeof json?.userId !== 'string') throw new StaffAdminError('unexpected');
      return { userId: json.userId };
    },

    async update({ actingUserId, userId, name, roleIds }) {
      await call(actingUserId, 'PATCH', `/v1/users/${userId}`, {
        ...(name === undefined ? {} : { name }),
        ...(roleIds === undefined ? {} : { roleIds }),
      });
    },

    async setActive({ actingUserId, userId, active }) {
      await call(
        actingUserId,
        'POST',
        `/v1/users/${userId}/${active ? 'reactivate' : 'deactivate'}`,
      );
    },

    async setLimits({ actingUserId, storeId, roleId, limits }) {
      await call(actingUserId, 'PUT', '/v1/role-limits', { storeId, roleId, ...limits });
    },

    async renameDevice({ actingUserId, name }) {
      await call(actingUserId, 'PATCH', '/v1/devices/me', { deviceName: name });
    },

    async createRole({ actingUserId, name, copyFromRoleId }) {
      const json = (await call(actingUserId, 'POST', '/v1/roles', { name, copyFromRoleId })) as {
        readonly roleId?: unknown;
      } | null;
      if (typeof json?.roleId !== 'string') throw new StaffAdminError('unexpected');
      return { roleId: json.roleId };
    },

    async updateRole({ actingUserId, roleId, name, permissionIds, limited }) {
      await call(actingUserId, 'PATCH', `/v1/roles/${roleId}`, {
        ...(name === undefined ? {} : { name }),
        ...(permissionIds === undefined ? {} : { permissionIds }),
        ...(limited === undefined ? {} : { limited }),
      });
    },

    async deleteRole({ actingUserId, roleId }) {
      await call(actingUserId, 'DELETE', `/v1/roles/${roleId}`);
    },
  };
}

/** The api/00 §7 error envelope's code, mapped to what the owner can do about it. */
async function failureOf(response: Response): Promise<StaffAdminFailure> {
  const json = (await response.json().catch(() => null)) as {
    readonly error?: { readonly code?: unknown };
  } | null;
  const code = json?.error?.code;
  if (code === 'LAST_ADMIN_PROTECTED') return 'lastOwner';
  if (response.status === 403 || response.status === 404) return 'denied';
  if (response.status === 429) return 'rateLimited';
  // A gateway with no route to the server is the same as no connection to the owner.
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return 'offline';
  }
  return 'unexpected';
}
