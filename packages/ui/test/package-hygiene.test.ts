/**
 * Package hygiene — the gates that keep this package's CONTRACTS true as it grows, rather than
 * true only today.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = join(pkgRoot, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * These gates police CODE, not prose. The rationale comments throughout this package legitimately
 * cite the very things the gates hunt for — `t('core.errors.' + code)`, hex values from §1.1,
 * "no `toMatchSnapshot`" — and a gate that fired on its own documentation would just teach the next
 * author to stop writing the documentation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * This file is exempt from its own pattern gates: it necessarily contains the exact strings it
 * hunts for, in its regexes. Same reasoning — and same precedent — as the repo's existing
 * `bolusi/rule-fixture-exemption` ESLint block for RuleTester suites.
 */
const SELF = 'package-hygiene.test.ts';

const files = sourceFiles(srcRoot);
const sources = files.map(
  (file) => [file.slice(pkgRoot.length), stripComments(readFileSync(file, 'utf8'))] as const,
);

test('there are source files to police (guards the gates below from passing vacuously)', () => {
  expect(files.length).toBeGreaterThan(15);
});

describe('dependencies (08-stack §3.2/§3.3)', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  test('runtime deps carry no styling, animation, font or icon library', () => {
    const shipped = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
    const banned = [
      'nativewind',
      'tamagui',
      'styled-components',
      '@shopify/restyle',
      'emotion',
      'react-native-reanimated',
      'lottie-react-native',
      'moti',
      'expo-font',
      '@shopify/flash-list',
    ];
    for (const dep of banned) expect(shipped).not.toContain(dep);
  });

  test('the dependency surface stays within the 08 §3.3 allowance for @bolusi/ui', () => {
    const allowed = ['@bolusi/i18n', 'react', 'react-native', 'expo-image', '@expo/vector-icons'];
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
      expect(allowed).toContain(dep);
    }
  });
});

describe('no literals, no t() (07-i18n §4.1; 08-stack §3.3)', () => {
  /**
   * `\bt(` rather than a bare `t(` substring: the latter matches `parseInt(`, `import(` and friends
   * and would make this gate noise. `@bolusi/ui` receives resolved strings as props — a `t()` call
   * here would mean the package had started resolving copy, which it may not do (it may import
   * `@bolusi/i18n` for KEY TYPES only).
   */
  test.each(sources)('%s calls no t()', (_file, source) => {
    expect(source).not.toMatch(/\bt\(/);
  });

  test.each(sources)('%s imports no i18n runtime', (_file, source) => {
    expect(source).not.toMatch(/from '@bolusi\/i18n'/);
    expect(source).not.toMatch(/from 'i18next'/);
  });

  test.each(sources)('%s constructs no Intl formatter directly (07-i18n §5)', (_file, source) => {
    expect(source).not.toMatch(/new Intl\./);
  });
});

describe('test-quality invariants (testing-guide T-5)', () => {
  const testFiles = sourceFiles(join(pkgRoot, 'test'))
    .filter((file) => !file.endsWith(SELF))
    .map(
      (file) => [file.slice(pkgRoot.length), stripComments(readFileSync(file, 'utf8'))] as const,
    );

  test('there are test files to police', () => {
    expect(testFiles.length).toBeGreaterThan(3);
  });

  test.each([...sources, ...testFiles])('%s has no snapshot assertion', (_file, source) => {
    expect(source).not.toMatch(/toMatchSnapshot|toMatchInlineSnapshot/);
  });
});

describe('tokens are the only styling vocabulary (design-system §1, §7)', () => {
  const nonTokenSources = sources.filter(([file]) => !file.endsWith('tokens.ts'));

  test('no raw hex colour outside tokens.ts (sources are already comment-stripped)', () => {
    for (const [file, source] of nonTokenSources) {
      const hits = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hits, `${file} contains raw hex ${hits.join(', ')}`).toEqual([]);
    }
  });

  test('no styling library import anywhere', () => {
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(/from 'nativewind|from 'tamagui|styled-components|restyle/);
      expect(source, file).not.toMatch(/react-native-reanimated/);
    }
  });
});

describe('the icon whitelist is the only path to glyphs (design-system §7)', () => {
  test('only Icon.tsx imports @expo/vector-icons', () => {
    const importers = sources
      .filter(([, source]) => /@expo\/vector-icons/.test(source))
      .map(([file]) => file);
    expect(importers).toEqual([expect.stringContaining('Icon.tsx')]);
  });
});

describe('FlatList is contained to the List primitive within this package (design-system §3.13)', () => {
  // Package-internal invariant only: `List` is the single place inside @bolusi/ui that touches
  // FlatList, so the windowing config and the engine-swap seam live in one file. This does NOT
  // police screens (they live in other packages) — that convention is task 24's screen import-
  // boundary rule.
  test('only List.tsx imports FlatList inside @bolusi/ui/src', () => {
    const importers = sources
      .filter(([file, source]) => !file.endsWith('List.tsx') && /\bFlatList\b/.test(source))
      .map(([file]) => file);
    expect(importers).toEqual([]);
  });
});
