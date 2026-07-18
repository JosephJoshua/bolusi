// Per-category channel creation + the mute binding (api/04-push §3/§5). Exercises task 24's
// `bootstrap/notifications.ts` — REUSED, not re-created (CLAUDE.md §2.8) — with expo-notifications
// mocked. This pins the api/04 §3 category→channel contract that push routing/muting depends on.
//
// SCOPE NOTE (task 59): api/04-push §5 models muting as channel IMPORTANCE, but Android forbids
// changing a channel's importance after creation (Context7 / expo docs; CLAUDE.md §2.11). Whether
// `applyChannelImportance` actually mutes ON THE TARGET is task 59's open defect — this test asserts
// only the CLIENT BINDING (which channel id it touches), never that Android honours a post-creation
// importance change.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setNotificationChannelAsync: vi.fn() }));
vi.mock('expo-notifications', () => ({
  setNotificationChannelAsync: mocks.setNotificationChannelAsync,
  AndroidImportance: { MIN: 1, DEFAULT: 3 },
}));

import {
  applyChannelImportance,
  channelId,
  createNotificationChannels,
} from '../bootstrap/notifications.js';
import { defaultMuteState, MUTABLE_PUSH_CATEGORIES } from '../screens/settings/model.js';

beforeEach(() => {
  mocks.setNotificationChannelAsync.mockReset();
  mocks.setNotificationChannelAsync.mockResolvedValue(undefined);
});

describe('createNotificationChannels (api/04-push §3/§5)', () => {
  test('creates one channel per VISIBLE category (conflict, device); sync gets none', async () => {
    const created = await createNotificationChannels(defaultMuteState());
    const idsTouched = mocks.setNotificationChannelAsync.mock.calls.map((c) => c[0]);

    expect(idsTouched.sort()).toEqual([channelId('conflict'), channelId('device')].sort());
    expect([...created].sort()).toEqual([channelId('conflict'), channelId('device')].sort());
    // sync is data-only (§3: no visible notification) → no channel, ever.
    expect(idsTouched).not.toContain('bolusi.sync');
    expect(MUTABLE_PUSH_CATEGORIES).not.toContain('sync');
  });
});

describe('mute binding (api/04-push §5; platform reality is task 59)', () => {
  test('applyChannelImportance touches ONLY the target category channel', async () => {
    await applyChannelImportance('conflict', true);
    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledTimes(1);
    expect(mocks.setNotificationChannelAsync.mock.calls[0]![0]).toBe(channelId('conflict'));
    // The device channel is left untouched.
    const idsTouched = mocks.setNotificationChannelAsync.mock.calls.map((c) => c[0]);
    expect(idsTouched).not.toContain(channelId('device'));
  });
});
