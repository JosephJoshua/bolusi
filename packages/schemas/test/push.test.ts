// The ONE push channel-id scheme (api/04-push §4/§5). This vocabulary is re-used by BOTH the server
// (payload composition) and the mobile app (Android channel creation); it lives here — the shared
// home this package already gives the locale vocabulary (task 77) — so the two sides cannot drift
// (CLAUDE.md §2.8). `channelId = 'bolusi.' + category` for a VISIBLE category (api/04-push §3): the
// value the server puts on the push must equal the id the app created the channel under, byte for
// byte, or Android routes the notification to a default channel and silently defeats the user's
// per-category mute (task 107).
import { describe, expect, it } from 'vitest';

import { pushChannelId } from '../src/push.js';

describe('pushChannelId — the shared channel-id scheme (api/04-push §4/§5)', () => {
  it('maps a category to `bolusi.<category>`, byte for byte', () => {
    expect(pushChannelId('conflict')).toBe('bolusi.conflict');
    expect(pushChannelId('device')).toBe('bolusi.device');
  });

  it('is prefix + category and nothing else — no separator drift, no casing change', () => {
    expect(pushChannelId('anything')).toBe('bolusi.anything');
  });
});
