// `eas.json` matches 08 §5.5 (this task's gate: "`eas.json` matches 08 §5.5 verbatim").
//
// The profiles are read from the REAL eas.json — the file EAS actually builds from — rather than
// from a fixture, because the only thing worth asserting here is that the shipping file is right.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

// A string path, not `new URL(…)`: under Expo's tsconfig base the global `URL` is DOM's, which
// node's `fileURLToPath` does not accept.
const HERE = dirname(fileURLToPath(import.meta.url));

interface EasProfile {
  readonly developmentClient?: boolean;
  readonly distribution?: string;
  readonly channel?: string;
  readonly extends?: string;
  readonly env?: Record<string, string>;
  readonly android?: { readonly buildType?: string };
}

const eas = JSON.parse(readFileSync(resolve(HERE, '../eas.json'), 'utf8')) as {
  readonly build: Record<string, EasProfile>;
};

describe('eas.json carries exactly 08 §5.5`s four profiles', () => {
  test('all four exist, and no fifth has crept in', () => {
    // The denominator (T-14): asserting only the four we check would let a fifth profile — say one
    // that quietly disabled the harness flag or pointed at a different channel — ride along unseen.
    expect(Object.keys(eas.build).sort()).toEqual(['development', 'preview', 'production', 'test']);
  });

  test('`development`: dev client, internal, Android APK, channel `dev`', () => {
    const profile = eas.build['development'];
    expect(profile?.developmentClient).toBe(true);
    expect(profile?.distribution).toBe('internal');
    expect(profile?.android?.buildType).toBe('apk');
    expect(profile?.channel).toBe('dev');
  });

  test('`preview`: release (NOT a dev client), internal, Android APK, channel `preview`', () => {
    const profile = eas.build['preview'];
    // §5.5 calls this "release build" — the D4 exit criterion runs on the 2 GB device against a
    // release build, so a dev client here would benchmark the wrong binary entirely.
    expect(profile?.developmentClient).toBeUndefined();
    expect(profile?.distribution).toBe('internal');
    expect(profile?.android?.buildType).toBe('apk');
    expect(profile?.channel).toBe('preview');
  });

  test('`test`: preview`s settings + BOLUSI_TEST_HARNESS=1, channel `test`', () => {
    const profile = eas.build['test'];
    // "preview settings + env" — expressed as `extends`, so the two cannot drift apart when the
    // preview profile changes. This is what plumbs the flag through for tasks 26/27's L6 screen.
    expect(profile?.extends).toBe('preview');
    expect(profile?.env).toEqual({ BOLUSI_TEST_HARNESS: '1' });
    expect(profile?.channel).toBe('test');
  });

  test('the harness flag is on the `test` profile ONLY — never on a profile a user can get', () => {
    // The flag exposes in-app harness hooks (§5.5: "Never distributed to users"). A copy of it on
    // development/preview/production would hand those hooks to a real shop.
    for (const name of ['development', 'preview', 'production']) {
      expect(eas.build[name]?.env?.['BOLUSI_TEST_HARNESS'], name).toBeUndefined();
    }
  });

  test('`production` is a channel placeholder — out of v0 use (§5.5)', () => {
    expect(eas.build['production']).toEqual({ channel: 'production' });
  });
});
