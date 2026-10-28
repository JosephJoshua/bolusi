// The first-run setup marker: pending for the enrolling owner, done for good once finished.
import { CamelCasePlugin, Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createClientDialect,
  runClientMigrations,
  type ClientDatabase,
  type DbDriver,
} from '@bolusi/db-client';
import { openMemoryDriver } from '@bolusi/sqlite-test-driver';

import {
  DEVICE_SETUP_META_KEY,
  finishDeviceSetup,
  markDeviceSetupPending,
  readDeviceSetupFor,
  writeMeta,
} from '../../src/index.js';

let driver: DbDriver | null = null;
let db: Kysely<ClientDatabase> | null = null;

async function open(): Promise<Kysely<ClientDatabase>> {
  driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  return db;
}

afterEach(async () => {
  await db?.destroy();
  await driver?.close();
  db = null;
  driver = null;
});

describe('device setup', () => {
  it('waits for nobody on a device registered before setup existed', async () => {
    expect(await readDeviceSetupFor(await open())).toBeNull();
  });

  it('waits for the enrolling owner until it is finished', async () => {
    const k = await open();
    await markDeviceSetupPending(k, 'owner-1');
    expect(await readDeviceSetupFor(k)).toBe('owner-1');
    await finishDeviceSetup(k);
    expect(await readDeviceSetupFor(k)).toBeNull();
  });

  it('does not ask again when a set-up device is registered again', async () => {
    const k = await open();
    await finishDeviceSetup(k);
    await markDeviceSetupPending(k, 'owner-2');
    expect(await readDeviceSetupFor(k)).toBeNull();
  });

  it('moves to the owner who registers again before it was finished', async () => {
    const k = await open();
    await markDeviceSetupPending(k, 'owner-1');
    await markDeviceSetupPending(k, 'owner-2');
    expect(await readDeviceSetupFor(k)).toBe('owner-2');
  });

  it('reads a damaged marker as nothing to do', async () => {
    const k = await open();
    await writeMeta(k, DEVICE_SETUP_META_KEY, 'pending:');
    expect(await readDeviceSetupFor(k)).toBeNull();
    await writeMeta(k, DEVICE_SETUP_META_KEY, 'something');
    expect(await readDeviceSetupFor(k)).toBeNull();
  });
});
