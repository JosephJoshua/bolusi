// CROSS-SIDE channel-id parity (CLAUDE.md §2.8/§2.11; api/04-push §4/§5; task 107).
//
// The SERVER composes a push with `channelId = pushChannelId(category)`; the MOBILE app creates its
// Android channels under those SAME ids. Android routes a delivered notification by EXACT channelId,
// so a channelId the server sends that names NO created channel drops the notification onto a default
// channel and silently defeats the user's per-category mute — the whole task-107 defect. The two
// category sets are maintained in different apps (`apps/server` `PUSH_CATEGORIES` vs this app's
// `MUTABLE_PUSH_CATEGORIES`); NOTHING but this test forces them to agree.
//
// The two apps cannot import each other. This test EXECUTES the mobile side for real —
// `createNotificationChannels` with `expo-notifications` mocked, exactly as the app runs it at boot —
// and READS the server's real `PUSH_CATEGORIES` from source (never a re-typed copy; the
// enum-mirror-parity / T-14 discipline), deriving each expected channel id through the ONE shared
// `pushChannelId` both sides use. The channel-id VALUE for each side is separately pinned to
// `pushChannelId` by that side's own unit test (server: payload.test.ts; mobile: channels.test.ts);
// THIS test is the cross-side check that the two category sets — and therefore the channel ids
// derived from them — cover each other with nothing left over.
//
// FALSIFICATION (§2.11): break the mobile channel scheme (e.g. `channelId` → `bolusi.<cat>X`), or add
// a VISIBLE category to the server's `PUSH_CATEGORIES` with no matching mobile channel → this test
// goes RED; restore → green.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { pushChannelId } from '@bolusi/schemas';
import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setNotificationChannelAsync: vi.fn() }));
vi.mock('expo-notifications', () => ({
  setNotificationChannelAsync: mocks.setNotificationChannelAsync,
  AndroidImportance: { MIN: 1, DEFAULT: 3 },
}));

import { createNotificationChannels } from '../bootstrap/notifications.js';
import { defaultMuteState } from '../screens/settings/model.js';

/** api/04-push §3: the sole DATA-ONLY category — a wake with no visible notification, no channel. */
const DATA_ONLY_CATEGORY = 'sync';

/** The server's real category set, read from its source so a rename/edit cannot pass unnoticed. */
const SERVER_PAYLOAD = new URL('../../../server/src/push/payload.ts', import.meta.url);

/** Comments legitimately name the const; strip them so they never false-match (enum-mirror-parity). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Extract `const <name> = ['a', 'b', …] as const` from source text. Throws on a miss or an empty set
 * — a parity gate that silently compares nothing is worse than no gate (CLAUDE.md §2.11 / T-14).
 * Reading the REAL server source (not a re-typed literal) is what keeps this honest.
 */
function extractConstStringArray(source: string, name: string): string[] {
  const body = stripComments(source).match(
    new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]\\s*as\\s+const`),
  )?.[1];
  if (body === undefined) {
    throw new Error(
      `parity gate could not locate \`const ${name} = [...] as const\` in the server payload — it was renamed or moved; refusing to pass vacuously (T-14).`,
    );
  }
  const members = [...body.matchAll(/['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((m): m is string => m !== undefined);
  if (members.length === 0) {
    throw new Error(`parity gate extracted zero members from \`${name}\` (T-14).`);
  }
  return members;
}

describe('server ↔ mobile push channel-id parity (task 107; §2.8/§2.11)', () => {
  test('every VISIBLE category the server can send has a matching created channel id on mobile', async () => {
    const serverCategories = extractConstStringArray(
      readFileSync(fileURLToPath(SERVER_PAYLOAD), 'utf8'),
      'PUSH_CATEGORIES',
    );

    // Denominator (T-14): the data-only exclusion must be REAL — `sync` is genuinely in the server
    // set — and the remaining visible set must be non-empty, or the parity below compares nothing.
    expect(serverCategories).toContain(DATA_ONLY_CATEGORY);
    const serverVisible = serverCategories.filter((c) => c !== DATA_ONLY_CATEGORY);
    expect(serverVisible.length).toBeGreaterThan(0);

    // What the SERVER will address (it composes `channelId = pushChannelId(category)`).
    const serverChannelIds = serverVisible.map((c) => pushChannelId(c)).sort();

    // What the MOBILE app actually creates at boot — executed for real, expo mocked.
    const mobileChannelIds = [...(await createNotificationChannels(defaultMuteState()))].sort();

    // Byte-for-byte, both directions: no server-sendable category lacks a mobile channel, and mobile
    // creates no channel the server never addresses.
    expect(mobileChannelIds).toEqual(serverChannelIds);

    // And the data-only category is never given a channel on either side.
    expect(mobileChannelIds).not.toContain(pushChannelId(DATA_ONLY_CATEGORY));
  });
});
