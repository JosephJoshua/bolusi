// Per-category channel creation (api/04-push §3/§5). Exercises task 24's `bootstrap/notifications.ts`
// — REUSED, not re-created (CLAUDE.md §2.8) — with expo-notifications mocked. This pins the api/04 §3
// category→channel contract that push routing and muting depend on.
//
// SCOPE NOTE (task 59, RESOLVED by D18 §1): api/04-push §5 no longer models muting as channel
// IMPORTANCE — Android forbids an app changing a channel's importance after creation (Context7 / expo
// docs; CLAUDE.md §2.11), and iOS has no channels. Muting is now the USER's, in the OS notification
// settings the in-app row deep-links to (`src/push/notification-settings.ts`); the resolving-no-op
// `applyChannelImportance` was DELETED. The channels are still created at boot — that is what makes the
// OS settings screen offer per-category controls — which is exactly what this file pins.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setNotificationChannelAsync: vi.fn() }));
vi.mock('expo-notifications', () => ({
  setNotificationChannelAsync: mocks.setNotificationChannelAsync,
  AndroidImportance: { MIN: 1, DEFAULT: 3 },
}));

import { channelId, createNotificationChannels } from '../bootstrap/notifications.js';
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
