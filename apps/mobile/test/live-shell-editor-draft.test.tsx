/**
 * THE COMPOSED-APP TEST for task 145 — a half-written note must survive the two ways it was destroyed:
 * Android hardware back inside the editor EXITED THE APP, and any header-chrome tap UNMOUNTED the
 * surface. Both dropped the draft with none of the §8.1 confirm the editor's own header back runs.
 *
 * ── WHY IT MOUNTS `Root` AND DRIVES THE REAL `BackHandler` ──────────────────────────────────────
 * The defect lives in the SEAM between the shell and a module surface the shell navigates privately:
 * `zone.ts` reads `home` as top-of-stack (so back = `exitApp`) and `App.tsx` unmounts `NotesHome` on a
 * chrome tap. `zone.ts` was already tested and STILL produced `exitApp` — so a test that checks
 * `backTarget`'s return value proves nothing (task 145's own warning). This drives the composition
 * root end to end: boot the REAL data layer, unlock a REAL session, open the REAL editor, dirty it,
 * and fire the REAL Android hardware back / tap the REAL header chrome — then assert the app did NOT
 * exit and the draft's ConfirmSheet appeared. Everything below the seam is REAL for the reasons
 * `live-shell-notes.test.tsx` states; the fakes are identical and for the same reason (Node cannot
 * run SecureStore, the status bar, the notification channels or the location watcher).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
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

import * as SecureStore from 'expo-secure-store';

import { fire, type RenderResult } from '../../../packages/ui/test/render.js';

import { __emitHardwareBack, __resetHardwareBack } from './doubles/react-native.js';
import {
  bootFixture,
  closeClientDb,
  enrolledDevice,
  fireOn,
  mountRoot,
  seedDirectory,
  settle,
  submitPin,
  TEST_PIN,
  type Fixture,
} from './live-shell-support.js';

/** A half-written body — the draft the two defects destroyed. */
const HALF_WRITTEN = 'ganti layar LCD, tunggu sparepart';

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  __resetHardwareBack();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-editor-'));
  secureStore = new Map<string, string>();
  vi.clearAllMocks();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(
    async (key: string) => secureStore.get(key) ?? null,
  );
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
    secureStore.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key: string) => {
    secureStore.delete(key);
  });
});

afterEach(async () => {
  await fixture?.close();
  fixture = null;
  await closeClientDb();
  __resetHardwareBack();
  rmSync(tempDir, { recursive: true, force: true });
});

/** Boot an enrolled+seeded device, unlock it with the real PIN, and land on the notes list. */
async function unlockedShell(): Promise<RenderResult> {
  fixture = await bootFixture();
  await enrolledDevice(fixture);
  await seedDirectory(fixture);

  const screen = await mountRoot(fixture);
  fireOn(screen, `switcher-user-${fixture.userId}`);
  await settle();
  const opened = await submitPin(screen, TEST_PIN);
  expect(opened).toBe(true);
  expect(screen.query('notes.list.title')).not.toBeNull();
  return screen;
}

/** Land on the notes list, then open the create editor. */
async function openEditor(): Promise<RenderResult> {
  const screen = await unlockedShell();
  fireOn(screen, 'notes.list.create');
  await settle();
  // The editor is mounted and the list is gone — the denominator for every assertion below.
  expect(screen.query('notes.editor.title')).not.toBeNull();
  expect(screen.query('notes.list.title')).toBeNull();
  // Not dirty yet: no discard prompt is showing.
  expect(screen.query('notes.editor.discard')).toBeNull();
  return screen;
}

/** Type into the body — the real `onChangeText` the RN field fires — so the draft is dirty. */
async function typeBody(screen: RenderResult, text: string): Promise<void> {
  fire(screen.get('notes.editor.body.field'), 'onChangeText', text);
  await settle();
}

/** Fire the REAL Android `BackHandler`; returns whether a listener consumed it (RN's own semantics). */
async function pressHardwareBack(): Promise<boolean> {
  let consumed = false;
  await act(async () => {
    consumed = __emitHardwareBack();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
  return consumed;
}

describe('Leg A — Android hardware back inside the editor must not exit the app (task 145)', () => {
  test('THE REPRODUCTION, STANDING: a DIRTY editor + hardware back ⇒ ConfirmSheet, app NOT exited', async () => {
    const screen = await openEditor();
    await typeBody(screen, HALF_WRITTEN);

    const consumed = await pressHardwareBack();

    // `consumed === true` is the app-did-NOT-exit proof: the double returns false only when NO
    // listener answered, which is precisely the `exitApp`/`goBack → false` path this task removes.
    // (Before the fix `backTarget({shell,home})` was `exitApp` and `goBack` returned false.)
    expect(consumed).toBe(true);
    // The draft's discard gate fired — the SAME ConfirmSheet the header back raises.
    expect(screen.query('notes.editor.discard')).not.toBeNull();
    // The editor is still mounted with the draft intact; it did not silently drop to the list.
    expect(screen.query('notes.editor.title')).not.toBeNull();
    expect(screen.query('notes.list.title')).toBeNull();
  });

  test('POSITIVE CONTROL: a CLEAN editor + hardware back leaves at once, with NO prompt', async () => {
    // The arm that stops "always prompts" from passing. Nothing typed ⇒ nothing to discard ⇒ the
    // press behaves as a plain back and returns to the list without a ConfirmSheet.
    const screen = await openEditor();

    const consumed = await pressHardwareBack();

    expect(consumed).toBe(true);
    expect(screen.query('notes.editor.discard')).toBeNull();
    // Create-mode cancel returns to the list.
    expect(screen.query('notes.list.title')).not.toBeNull();
    expect(screen.query('notes.editor.title')).toBeNull();
  });

  test('confirming the discard leaves the editor; the draft is released', async () => {
    const screen = await openEditor();
    await typeBody(screen, HALF_WRITTEN);
    await pressHardwareBack();
    expect(screen.query('notes.editor.discard')).not.toBeNull();

    fireOn(screen, 'notes.editor.discard.confirm');
    await settle();

    // Confirmed: back on the list, editor and sheet gone.
    expect(screen.query('notes.list.title')).not.toBeNull();
    expect(screen.query('notes.editor.title')).toBeNull();
    expect(screen.query('notes.editor.discard')).toBeNull();
  });

  test('cancelling the discard keeps the editor AND the draft — a second back re-raises the sheet', async () => {
    const screen = await openEditor();
    await typeBody(screen, HALF_WRITTEN);
    await pressHardwareBack();
    expect(screen.query('notes.editor.discard')).not.toBeNull();

    fireOn(screen, 'notes.editor.discard.cancel');
    await settle();

    // Still editing, sheet dismissed.
    expect(screen.query('notes.editor.discard')).toBeNull();
    expect(screen.query('notes.editor.title')).not.toBeNull();

    // The draft was NOT lost by cancelling: a second hardware back finds it still dirty and re-raises
    // the gate. If the body had been dropped, this back would leave clean with no prompt.
    const consumed = await pressHardwareBack();
    expect(consumed).toBe(true);
    expect(screen.query('notes.editor.discard')).not.toBeNull();
    expect(screen.query('notes.editor.title')).not.toBeNull();
  });
});

describe('Leg B — a header-chrome tap must not discard the draft (task 145)', () => {
  test('THE REPRODUCTION, STANDING: dirty editor + AVATAR tap ⇒ ConfirmSheet, surface NOT unmounted', async () => {
    const screen = await openEditor();
    await typeBody(screen, HALF_WRITTEN);
    // Denominator: the switcher the avatar opens is NOT already showing.
    expect(screen.query('switcher-screen')).toBeNull();

    fireOn(screen, 'ui.avatarButton');
    await settle();

    // Before the fix this tap unmounted `NotesHome` — `switcher-screen` present, draft gone, no
    // confirm. Now it routes through the editor's discard gate: the sheet is up and the editor lives.
    expect(screen.query('notes.editor.discard')).not.toBeNull();
    expect(screen.query('switcher-screen')).toBeNull();
    expect(screen.query('notes.editor.title')).not.toBeNull();
  });

  test('THE REPRODUCTION, STANDING: dirty editor + LANGUAGE-CHIP tap ⇒ ConfirmSheet, no navigation', async () => {
    // The Bahasa chip the task names explicitly, and the SyncChip's sibling in the same slot (§8.1).
    const screen = await openEditor();
    await typeBody(screen, HALF_WRITTEN);
    expect(screen.query('settings-screen')).toBeNull();

    fireOn(screen, 'shell-open-settings');
    await settle();

    expect(screen.query('notes.editor.discard')).not.toBeNull();
    expect(screen.query('settings-screen')).toBeNull();
    expect(screen.query('notes.editor.title')).not.toBeNull();
  });

  test('confirming after a chrome tap DISCARDS and lands on the tapped destination', async () => {
    // Proves the `proceed` continuation: the leave resumes toward where the chrome was headed (the
    // switcher), not merely back to the list.
    const screen = await openEditor();
    await typeBody(screen, HALF_WRITTEN);

    fireOn(screen, 'ui.avatarButton');
    await settle();
    expect(screen.query('notes.editor.discard')).not.toBeNull();

    fireOn(screen, 'notes.editor.discard.confirm');
    await settle();

    expect(screen.query('switcher-screen')).not.toBeNull();
    expect(screen.query('notes.editor.title')).toBeNull();
  });

  test('POSITIVE CONTROL: a CLEAN editor + AVATAR tap navigates immediately, with NO prompt', async () => {
    const screen = await openEditor();

    fireOn(screen, 'ui.avatarButton');
    await settle();

    // Nothing to discard ⇒ the tap navigates straight through to the switcher, no ConfirmSheet.
    expect(screen.query('switcher-screen')).not.toBeNull();
    expect(screen.query('notes.editor.discard')).toBeNull();
  });
});
