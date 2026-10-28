// The module port runs a module's commands and queries by name, as one user, through the same
// runtimes and permission checks as a direct call.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError } from '../../src/errors/domain-error.js';
import { bindModulePort, type ModuleOperations } from '../../src/module/port.js';
import { openModuleHarness, type ModuleHarness } from './_harness.js';

let harness: ModuleHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

function portFor(h: ModuleHarness, userId: string) {
  const runtime = { registry: h.registry, commands: h.commands, queries: h.queries };
  return bindModulePort(h.module as unknown as ModuleOperations, runtime, {
    tenantId: h.tenantId,
    storeId: h.storeId,
    deviceId: h.deviceId,
    userId,
  }) as unknown as {
    readonly userId: string;
    run(name: string, input: unknown): Promise<{ id: string }>;
    query(name: string, input: unknown): Promise<{ rows: readonly { id: string }[] }>;
    hasPermission(permissionId: string): boolean;
    colleagueHasPermission(userId: string, permissionId: string): boolean;
  };
}

describe('bindModulePort', () => {
  test('runs a command and reads it back as the bound user', async () => {
    harness = await openModuleHarness(901);
    const port = portFor(harness, harness.adminId);
    const created = await port.run('createItem', { label: 'port-1', secretNote: 'n' });
    expect(created.id).toEqual(expect.any(String));
    const page = await port.query('listItems', {});
    expect(page.rows.map((row) => row.id)).toEqual([created.id]);
    expect(port.userId).toBe(harness.adminId);
  });

  test('enforces permissions exactly as the runtimes do', async () => {
    harness = await openModuleHarness(902);
    const port = portFor(harness, harness.zeroGrantId);
    const denied = await port.run('createItem', { label: 'x', secretNote: 'n' }).catch((e) => e);
    expect(denied).toBeInstanceOf(DomainError);
    expect((denied as DomainError).code).toBe('PERMISSION_DENIED');
    await expect(port.query('listItems', {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(port.hasPermission(String(Object.values(harness.module.commands!)[0]!.permission))).toBe(
      false,
    );
  });

  test('checks a colleague in the same store without changing the bound user', async () => {
    harness = await openModuleHarness(903);
    const port = portFor(harness, harness.zeroGrantId);
    const permission = String(Object.values(harness.module.commands!)[0]!.permission);
    expect(port.colleagueHasPermission(harness.adminId, permission)).toBe(true);
    expect(port.colleagueHasPermission(harness.zeroGrantId, permission)).toBe(false);
    expect(port.hasPermission(permission)).toBe(false);
  });
});
