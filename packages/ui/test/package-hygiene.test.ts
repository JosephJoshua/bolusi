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
    // @bolusi/schemas is allowed as a TYPE-ONLY dep (08 §3.3 rule 8, uiSchemasTypeOnly): it must be
    // declared so the canonical enum types resolve in ui's public .d.ts, but no ui source may
    // value-import it (policed below + by the boundaries lint rule) so no zod reaches the bundle.
    const allowed = [
      '@bolusi/i18n',
      '@bolusi/schemas',
      'react',
      'react-native',
      'expo-image',
      '@expo/vector-icons',
    ];
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
      expect(allowed).toContain(dep);
    }
  });
});

/**
 * Every import/export STATEMENT that pulls from @bolusi/schemas must be type-only, and no dynamic
 * `import()` / `require()` of it may exist. STATEMENT-based, not line-based: a growing
 * `import type { … }` list wraps across lines at prettier's printWidth (100) as ui pulls more enum
 * types from schemas — the invariant lives on the `import` keyword's clause, not on the closing
 * `} from '@bolusi/schemas';` line. `[^;]` bounds each clause to a single statement so an earlier
 * `import … from 'react';` cannot be spanned into and mis-judged. Returns one reason per violation;
 * empty ⇒ clean. Sources are already comment-stripped by the caller.
 */
function schemasValueEdges(source: string): string[] {
  const out: string[] = [];
  const statement = /\b(import|export)\b([^;]*?)\bfrom\s*'@bolusi\/schemas(?:\/[^']*)?'/g;
  for (const match of source.matchAll(statement)) {
    if (!/^\s*type\b/.test(match[2] ?? '')) {
      out.push(
        `value ${match[1]} of @bolusi/schemas — use \`import type\`/\`export type\` (no zod in ui)`,
      );
    }
  }
  if (/(?:import|require)\s*\(\s*'@bolusi\/schemas/.test(source)) {
    out.push('dynamic import()/require() of @bolusi/schemas is a runtime edge — forbidden in ui');
  }
  return out;
}

describe('@bolusi/schemas is type-only (08 §3.3 rule 8, uiSchemasTypeOnly)', () => {
  // The vitest twin of the `bolusi/boundaries` lint prong: a VALUE import/export of @bolusi/schemas
  // from any ui source would emit a runtime `require('@bolusi/schemas')` (verbatimModuleSyntax
  // preserves what you write) and drag zod into ui's platform-free Hermes bundle. Only a top-level
  // `import type` / `export type` is allowed — the same shape the boundaries rule enforces. Two
  // guards, one boundary: the lint rule can be silenced per-file with an eslint-disable; this cannot.
  test.each(sources)(
    '%s imports @bolusi/schemas type-only, never as a value (no zod in ui)',
    (file, source) => {
      expect(schemasValueEdges(source), file).toEqual([]);
    },
  );

  // Falsifies the detector itself (T-14: a guard that silently checks nothing is worse than none).
  // `${pkg}` keeps these fixtures out of any repo-wide value-import grep; they are strings, not
  // imports, so the AST boundaries rule never sees them either.
  test('detector is statement-based: multi-line type import OK; value + dynamic caught', () => {
    const pkg = ['@bolusi', 'schemas'].join('/');
    // Valid, zod-free — must stay clean even wrapped across lines (the reported false-positive).
    expect(
      schemasValueEdges(`import type {\n  SyncStatus,\n  SyncChipKind,\n} from '${pkg}';`),
    ).toEqual([]);
    expect(schemasValueEdges(`export type { SyncStatus } from '${pkg}';`)).toEqual([]);
    // An earlier unrelated import must not be spanned into and mis-flagged.
    expect(
      schemasValueEdges(
        `import { useMemo } from 'react';\nimport type { SyncStatus } from '${pkg}';`,
      ),
    ).toEqual([]);
    // Every value shape is a violation — single-line, multi-line, re-export, subpath, dynamic.
    expect(schemasValueEdges(`import { SyncStatus } from '${pkg}';`)).toHaveLength(1);
    expect(schemasValueEdges(`import {\n  SyncStatus,\n} from '${pkg}';`)).toHaveLength(1);
    expect(schemasValueEdges(`export { SyncStatus } from '${pkg}';`)).toHaveLength(1);
    expect(schemasValueEdges(`import { parse } from '${pkg}/bookkeeping';`)).toHaveLength(1);
    expect(schemasValueEdges(`const x = await import('${pkg}');`)).toHaveLength(1);
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
