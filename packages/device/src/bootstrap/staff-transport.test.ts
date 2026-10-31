// The staff fetch adapter: the wire the server's user endpoints expect, made as the acting owner on
// the device bearer, and the closed failure set the screens explain. `fetch` is injected.
import { StaffAdminError, staffAdminFailure } from '@bolusi/core';
import { describe, expect, test, vi } from 'vitest';

import { createFetchStaffAdmin } from './staff-transport.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function admin(fetchImpl: typeof fetch, token: string | null = 'bdt_secret') {
  return createFetchStaffAdmin({
    baseUrl: 'https://api.example.com',
    deviceToken: () => Promise.resolve(token),
    fetchImpl,
  });
}

function sent(doFetch: ReturnType<typeof vi.fn>) {
  const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body === undefined ? undefined : (JSON.parse(init.body as string) as unknown),
  };
}

describe('the staff wire', () => {
  test('create posts a PIN-only person in this store, as the owner', async () => {
    const doFetch = vi.fn(async () => jsonResponse(201, { userId: 'u-new' }));
    const result = await admin(doFetch as unknown as typeof fetch).create({
      actingUserId: 'u-owner',
      storeId: 's-1',
      name: 'Rina',
      roleIds: ['r-cashier', 'r-tech'],
    });
    expect(result).toEqual({ userId: 'u-new' });
    expect(sent(doFetch)).toEqual({
      url: 'https://api.example.com/v1/users',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer bdt_secret',
        'X-Acting-User': 'u-owner',
      },
      body: {
        name: 'Rina',
        loginIdentifier: null,
        password: null,
        storeIds: ['s-1'],
        roleIds: ['r-cashier', 'r-tech'],
        pinVerifier: null,
      },
    });
  });

  test('update sends only what changed; setActive picks the endpoint', async () => {
    const doFetch = vi.fn(async () => jsonResponse(200, { userId: 'u-1' }));
    const port = admin(doFetch as unknown as typeof fetch);
    await port.update({ actingUserId: 'u-owner', userId: 'u-1', roleIds: ['r-tech'] });
    expect(sent(doFetch)).toMatchObject({
      url: 'https://api.example.com/v1/users/u-1',
      method: 'PATCH',
      body: { roleIds: ['r-tech'] },
    });

    doFetch.mockClear();
    await port.setActive({ actingUserId: 'u-owner', userId: 'u-1', active: false });
    expect(sent(doFetch)).toMatchObject({
      url: 'https://api.example.com/v1/users/u-1/deactivate',
      method: 'POST',
      body: undefined,
    });
    doFetch.mockClear();
    await port.setActive({ actingUserId: 'u-owner', userId: 'u-1', active: true });
    expect(sent(doFetch).url).toBe('https://api.example.com/v1/users/u-1/reactivate');
  });

  test('setLimits puts a role’s three amounts at this store', async () => {
    const doFetch = vi.fn(async () => jsonResponse(200, { roleId: 'r-m', storeId: 's-1' }));
    await admin(doFetch as unknown as typeof fetch).setLimits({
      actingUserId: 'u-owner',
      storeId: 's-1',
      roleId: 'r-m',
      limits: { priceDrop: 50_000, refund: 0, credit: 100_000 },
    });
    expect(sent(doFetch)).toMatchObject({
      url: 'https://api.example.com/v1/role-limits',
      method: 'PUT',
      headers: { 'X-Acting-User': 'u-owner' },
      body: { storeId: 's-1', roleId: 'r-m', priceDrop: 50_000, refund: 0, credit: 100_000 },
    });
  });

  test('renameDevice patches this device’s name', async () => {
    const doFetch = vi.fn(async () => jsonResponse(200, { deviceId: 'd-1', deviceName: 'Kasir' }));
    await admin(doFetch as unknown as typeof fetch).renameDevice({
      actingUserId: 'u-owner',
      name: 'Kasir',
    });
    expect(sent(doFetch)).toMatchObject({
      url: 'https://api.example.com/v1/devices/me',
      method: 'PATCH',
      headers: { 'X-Acting-User': 'u-owner' },
      body: { deviceName: 'Kasir' },
    });
  });
});

describe('failures', () => {
  const failing = async (doFetch: () => Promise<Response>) => {
    try {
      await admin(doFetch as unknown as typeof fetch).setActive({
        actingUserId: 'u-owner',
        userId: 'u-1',
        active: false,
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(StaffAdminError);
      return staffAdminFailure(error);
    }
    throw new Error('expected a failure');
  };

  test('no answer is offline; the error envelope decides the rest', async () => {
    expect(await failing(() => Promise.reject(new TypeError('Network request failed')))).toBe(
      'offline',
    );
    expect(await failing(async () => jsonResponse(503, {}))).toBe('offline');
    expect(
      await failing(async () => jsonResponse(409, { error: { code: 'LAST_ADMIN_PROTECTED' } })),
    ).toBe('lastOwner');
    expect(
      await failing(async () => jsonResponse(403, { error: { code: 'PERMISSION_DENIED' } })),
    ).toBe('denied');
    expect(await failing(async () => jsonResponse(429, {}))).toBe('rateLimited');
    expect(await failing(async () => new Response('oops', { status: 500 }))).toBe('unexpected');
  });

  test('no device token sends nothing', async () => {
    const doFetch = vi.fn();
    await expect(
      admin(doFetch as unknown as typeof fetch, null).update({
        actingUserId: 'u-owner',
        userId: 'u-1',
        name: 'X',
      }),
    ).rejects.toBeInstanceOf(StaffAdminError);
    expect(doFetch).not.toHaveBeenCalled();
  });
});
