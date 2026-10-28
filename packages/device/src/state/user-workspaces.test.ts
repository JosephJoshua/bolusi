import { describe, expect, test } from 'vitest';

import { parseUserWorkspace } from './user-workspaces.js';

describe('parseUserWorkspace — a workspace an earlier app run saved', () => {
  test('a well-formed workspace comes back as saved', () => {
    const saved = { ownerUserId: 'u-1', route: 'settings', drafts: { repair: { step: 2 } } };
    expect(parseUserWorkspace(saved)).toEqual(saved);
  });

  test('a route this build no longer has falls back to home, keeping the drafts', () => {
    expect(parseUserWorkspace({ ownerUserId: 'u-1', route: 'gone', drafts: { notes: 1 } })).toEqual(
      { ownerUserId: 'u-1', route: 'home', drafts: { notes: 1 } },
    );
  });

  test.each([
    null,
    'text',
    [],
    { route: 'home', drafts: {} },
    { ownerUserId: 7, route: 'home', drafts: {} },
    { ownerUserId: 'u-1', route: 'home' },
    { ownerUserId: 'u-1', route: 'home', drafts: [] },
    { ownerUserId: 'u-1', route: 'home', drafts: null },
  ])('an unusable value reads as nothing: %j', (value) => {
    expect(parseUserWorkspace(value)).toBeUndefined();
  });
});
