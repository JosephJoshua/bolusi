/**
 * A half-entered servisan survives the app being torn down: Android recreating the activity (the
 * React tree remounts in the same JS context) or killing the process (the same, plus a fresh boot of
 * the database). Either way `Root` mounts again, boots the database from disk, and opens at the
 * switcher; nothing of the work shows before a PIN. An unfinished intake belongs to the device
 * (Joseph, 2026-10-31): whoever unlocks may carry on with it, and it says who started it.
 *
 * Drives the real `Root`, the real repair intake and real PIN verifies over a file-backed database
 * with the production column cipher. Node lane: it proves the composition, not that a device
 * delivers its lifecycle events (device QA covers that).
 */
import { DEVICE_WORK_KEY } from '@bolusi/core';
import { REPAIR_PERMISSION } from '@bolusi/modules/repair';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1 },
  setNotificationChannelAsync: vi.fn(async () => undefined),
  getNotificationChannelsAsync: vi.fn(async () => []),
}));

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  watchPositionAsync: vi.fn(async () => ({ remove: () => undefined })),
}));

import { fire, textsIn, type RenderResult } from '../../../packages/ui/test/render.js';
import { createSessionRepairRuntime, repairMediaSeamsFor } from '@bolusi/device/bootstrap/repair';
import type { AppSessionController } from '@bolusi/device/bootstrap/session';
import {
  bootFixture,
  closeClientDb,
  enrolledDevice,
  fireOn,
  mountRoot,
  NOTES_PERMISSIONS,
  seedTwoUsers,
  settle,
  submitPin,
  waitUntil,
  SECOND_USER_ID,
  TEST_PIN,
  type Fixture,
  type MountOptions,
} from './live-shell-support.js';

const COUNTER_PERMISSIONS = [...NOTES_PERMISSIONS, ...Object.values(REPAIR_PERMISSION)];

const CUSTOMER = 'Yohanis Wenda';
const PHONE = '0812-4455-6677';
const PASSCODE = '246810';

let fixture: Fixture | null = null;
let screen: RenderResult | null = null;

beforeEach(async () => {
  await closeClientDb();
});

afterEach(async () => {
  screen?.unmount();
  screen = null;
  await fixture?.close();
  fixture = null;
  await closeClientDb();
});

const withRepair: MountOptions['createRepair'] = (app, runtime, identity, media, capture) =>
  createSessionRepairRuntime({
    app,
    runtime,
    identity,
    media: repairMediaSeamsFor(media, {
      ...capture,
      loadModelPhoto: () => Promise.reject(new Error('no phone photos in this test')),
    }),
  });

/** Mount the live `Root` over the fixture's database file, as a fresh app start does. */
async function start(target: Fixture): Promise<{
  readonly screen: RenderResult;
  readonly controller: AppSessionController;
}> {
  let controller: AppSessionController | null = null;
  const mounted = await mountRoot(target, {
    createRepair: withRepair,
    onSessionController: (c) => {
      controller = c;
    },
  });
  if (controller === null) throw new Error('Root composed no session controller');
  return { screen: mounted, controller };
}

async function unlockAs(target: RenderResult, userId: string): Promise<boolean> {
  fireOn(target, `switcher-user-${userId}`);
  await settle();
  return submitPin(target, TEST_PIN);
}

async function press(target: RenderResult, testID: string): Promise<void> {
  fire(target.all(testID)[0]!, 'onPress');
  await settle();
}

async function type(target: RenderResult, testID: string, text: string): Promise<void> {
  fire(target.get(`${testID}.field`), 'onChangeText', text);
  await settle();
}

function valueOf(target: RenderResult, testID: string): unknown {
  return target.get(`${testID}.field`).props['value'];
}

/** The saved row, decrypted by the connection's cipher, or null when nothing reached disk yet. */
async function savedWork(target: Fixture, userId: string): Promise<string | null> {
  // An intake is kept under the device's own key, not a person's.
  const result = await sql<{ work: string }>`
    SELECT work FROM user_work WHERE user_id = ${userId}
  `.execute(target.app.db.db);
  return result.rows[0]?.work ?? null;
}

/** Start an intake as `fixture.userId` and fill the customer and part of the device step. */
async function typeHalfAnIntake(target: Fixture): Promise<void> {
  const app = await start(target);
  screen = app.screen;
  expect(await unlockAs(app.screen, target.userId)).toBe(true);
  expect(await waitUntil(() => app.screen.query('repair.board.newIntake') !== null)).toBe(true);
  await press(app.screen, 'repair.board.newIntake');
  await type(app.screen, 'repair.intake.customer.name', CUSTOMER);
  await type(app.screen, 'repair.intake.customer.phone', PHONE);
  await press(app.screen, 'repair.intake.primary');
  await type(app.screen, 'repair.intake.device.brand', 'Samsung');
  await press(app.screen, 'repair.intake.device.lock.kind.pin');
  await type(app.screen, 'repair.intake.device.lock.pin', PASSCODE);
  // Denominator: the draft is on disk before the app goes away, so a pass below is a real restore.
  expect(
    await waitUntil(
      async () => (await savedWork(target, DEVICE_WORK_KEY))?.includes(PASSCODE) === true,
    ),
  ).toBe(true);
  // Activity recreation or process death: the tree goes away with nothing flushed on the way out.
  app.screen.unmount();
  screen = null;
}

describe('a half-entered servisan survives the app being torn down', () => {
  test('the same user unlocks after a restart and is back on the step they left, fields intact', async () => {
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedTwoUsers(fixture, 300, COUNTER_PERMISSIONS);
    await typeHalfAnIntake(fixture);

    const app = await start(fixture);
    screen = app.screen;
    // The restart opens at the switcher, and nothing of the draft shows before a PIN.
    expect(app.controller.snapshot().session).toBeNull();
    expect(textsIn(app.screen.container).some((s) => s.includes(CUSTOMER))).toBe(false);

    expect(await unlockAs(app.screen, fixture.userId)).toBe(true);
    expect(await waitUntil(() => app.screen.query('repair.intake.step.device') !== null)).toBe(
      true,
    );
    expect(valueOf(app.screen, 'repair.intake.device.brand')).toBe('Samsung');
    expect(valueOf(app.screen, 'repair.intake.device.lock.pin')).toBe(PASSCODE);
    expect(app.controller.snapshot().deviceDrafts?.['repair']).toMatchObject({
      customer: { name: CUSTOMER, phone: PHONE },
      startedBy: { userId: fixture.userId, name: 'Andi Pratama' },
    });
    // Their own intake, so no "started by" line.
    expect(app.screen.query('repair.intake.startedBy')).toBeNull();
  });

  test('a colleague unlocking after the restart finds it waiting on the board and may carry on with it', async () => {
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedTwoUsers(fixture, 300, COUNTER_PERMISSIONS);
    await typeHalfAnIntake(fixture);

    const app = await start(fixture);
    screen = app.screen;
    expect(await unlockAs(app.screen, SECOND_USER_ID)).toBe(true);
    // It does not open by itself: it waits on the board's button.
    expect(await waitUntil(() => app.screen.query('repair.board.newIntake') !== null)).toBe(true);
    expect(app.screen.query('repair.intake.step.device')).toBeNull();
    expect(textsIn(app.screen.container)).toContain('Lanjutkan servisan baru');
    // B's own workspace holds none of it.
    expect(app.controller.snapshot().workspace?.ownerUserId).toBe(SECOND_USER_ID);
    expect(app.controller.snapshot().workspace?.drafts['repair'] ?? null).toBeNull();

    await press(app.screen, 'repair.board.newIntake');
    expect(await waitUntil(() => app.screen.query('repair.intake.step.device') !== null)).toBe(
      true,
    );
    expect(valueOf(app.screen, 'repair.intake.device.lock.pin')).toBe(PASSCODE);
    expect(textsIn(app.screen.get('repair.intake.startedBy'))).toContain(
      'Dimulai oleh Andi Pratama',
    );
  });

  test('handing the phone over mid-intake asks nothing, and the colleague carries on with it', async () => {
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedTwoUsers(fixture, 300, COUNTER_PERMISSIONS);
    const app = await start(fixture);
    screen = app.screen;
    expect(await unlockAs(app.screen, fixture.userId)).toBe(true);
    expect(await waitUntil(() => app.screen.query('repair.board.newIntake') !== null)).toBe(true);
    await press(app.screen, 'repair.board.newIntake');
    await type(app.screen, 'repair.intake.customer.name', CUSTOMER);
    await type(app.screen, 'repair.intake.customer.phone', PHONE);
    // The avatar is on the intake itself, and switching keeps the intake rather than asking.
    fireOn(app.screen, 'ui.avatarButton');
    fireOn(app.screen, 'account-menu-switch-user');
    await settle();
    expect(app.screen.query('repair.intake.discard')).toBeNull();
    expect(await waitUntil(() => app.screen.query('switcher-screen') !== null)).toBe(true);

    expect(await unlockAs(app.screen, SECOND_USER_ID)).toBe(true);
    expect(await waitUntil(() => app.screen.query('repair.board.newIntake') !== null)).toBe(true);
    await press(app.screen, 'repair.board.newIntake');
    expect(valueOf(app.screen, 'repair.intake.customer.name')).toBe(CUSTOMER);
    expect(textsIn(app.screen.get('repair.intake.startedBy'))).toContain(
      'Dimulai oleh Andi Pratama',
    );
  });
});
