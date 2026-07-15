import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

import config, { bolusi } from './index.js';

test('all bolusi custom rules are registered at error in the flat config', () => {
  // `no-token-literals` added task 23 (design-system §7 lint (a)).
  expect(Object.keys(bolusi.rules).sort()).toEqual([
    'boundaries',
    'no-float-money',
    'no-hardcoded-strings',
    'no-op-table-update',
    'no-token-literals',
  ]);

  const ruleLevel = (ruleId) => {
    for (const block of config) {
      const entry = block.rules?.[ruleId];
      if (entry !== undefined) return Array.isArray(entry) ? entry[0] : entry;
    }
    return undefined;
  };

  expect(ruleLevel('bolusi/boundaries')).toBe('error');
  expect(ruleLevel('bolusi/no-op-table-update')).toBe('error');
  expect(ruleLevel('bolusi/no-float-money')).toBe('error');
  expect(ruleLevel('bolusi/no-hardcoded-strings')).toBe('error');
  expect(ruleLevel('bolusi/no-token-literals')).toBe('error');
});

test('repo-wide rules are not scoped to a files subset', () => {
  const repoWide = config.find(
    (block) => block.rules?.['bolusi/boundaries'] === 'error' && !block.files,
  );
  expect(repoWide).toBeDefined();
  expect(repoWide.rules['bolusi/no-op-table-update']).toBe('error');
});

test('no-float-money literal prong is scoped to schema files only (F1)', () => {
  const broad = config.find((block) => block.name === 'bolusi/money');
  // Assert the F1 invariant (the literal prong's per-block state) rather than the whole
  // options object, so unrelated options (task 29's float carve-out) don't false-fail here;
  // the carve-out has its own assertions below.
  expect(broad.rules['bolusi/no-float-money'][0]).toBe('error');
  expect(broad.rules['bolusi/no-float-money'][1].numericLiterals).toBe(false);
  expect(broad.files).toContain('packages/modules/src/**/*.{ts,tsx}');

  const schemaOnly = config.find((block) => block.name === 'bolusi/money-schema-files');
  expect(schemaOnly.rules['bolusi/no-float-money'][0]).toBe('error');
  expect(schemaOnly.rules['bolusi/no-float-money'][1].numericLiterals).toBe(true);
  // the schema-file convention: whole schemas package + named module schema files
  expect(schemaOnly.files).toEqual([
    'packages/schemas/src/**/*.{ts,tsx}',
    'packages/modules/src/**/*.schema.{ts,tsx}',
    'packages/modules/src/**/{schema,schemas,ops,operations,commands,queries}.ts',
  ]);
  // within modules, only the named schema-file conventions — never screens or a catch-all
  const moduleGlobs = schemaOnly.files.filter((glob) => glob.startsWith('packages/modules/'));
  expect(moduleGlobs.length).toBeGreaterThan(0);
  expect(
    moduleGlobs.some((glob) => glob.includes('screens') || glob.endsWith('**/*.{ts,tsx}')),
  ).toBe(false);
});

test('the float carve-out is narrow and identical in both money blocks (task 29)', () => {
  const blocks = ['bolusi/money', 'bolusi/money-schema-files'].map((name) =>
    config.find((block) => block.name === name),
  );

  for (const block of blocks) {
    const [, options] = block.rules['bolusi/no-float-money'];
    // exactly one file and exactly the three location props — nothing broader ever
    // silently joins the allowlist
    expect(options.allowFloatFiles).toEqual(['packages/schemas/src/envelope.ts']);
    expect(options.allowFloatProps).toEqual(['lat', 'lng', 'accuracyMeters']);
    // the carve-out must not admit a money-named prop
    expect(
      options.allowFloatProps.some((prop) => /(amount|price|cost|total|fee|idr)/i.test(prop)),
    ).toBe(false);
  }

  // Flat-config rule options REPLACE rather than merge: envelope.ts matches BOTH blocks, so
  // if the carve-out were only in the earlier block the later one would drop it and lint
  // would break. Pin that they agree.
  const [broadOptions, schemaOptions] = blocks.map(
    (block) => block.rules['bolusi/no-float-money'][1],
  );
  expect(broadOptions.allowFloatFiles).toEqual(schemaOptions.allowFloatFiles);
  expect(broadOptions.allowFloatProps).toEqual(schemaOptions.allowFloatProps);
});

// 07-i18n §5: the `new Intl.` ban. Linting real file paths through the actual flat config is the
// only way to prove the packages/i18n exemption resolves — asserting on the config object would
// just restate it.
test('direct Intl use fails outside packages/i18n and passes inside it (07-i18n §5)', async () => {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
  const source = 'const f = new Intl.NumberFormat("id-ID");\n';

  const lintAt = async (filePath) => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((message) => message.ruleId);
  };

  expect(await lintAt('apps/mobile/src/screens/Notes.tsx')).toContain('no-restricted-syntax');
  expect(await lintAt('packages/modules/src/notes/screens/List.tsx')).toContain(
    'no-restricted-syntax',
  );
  expect(await lintAt('packages/i18n/src/formatters.ts')).not.toContain('no-restricted-syntax');
});

// Added task 23. Prove the two scope changes resolve through the REAL flat config, not just the
// config object — the packages/ui addition and the tokens.ts exemption are the load-bearing parts.
test('no-hardcoded-strings now covers packages/ui but exempts its tests (§7 lint (b))', async () => {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
  const lintAt = async (source, filePath) => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.ruleId);
  };

  // A JSX string literal in ui source is an error.
  expect(
    await lintAt('const el = <Text>Simpan</Text>;\n', 'packages/ui/src/components/Button.tsx'),
  ).toContain('bolusi/no-hardcoded-strings');
  // The catalog path (resolved string as a prop) is clean.
  expect(
    await lintAt('const el = <Text>{label}</Text>;\n', 'packages/ui/src/components/Button.tsx'),
  ).not.toContain('bolusi/no-hardcoded-strings');
  // Test files carry placeholder copy as inert fixture data and are exempt.
  expect(
    await lintAt('const el = <Text>Simpan</Text>;\n', 'packages/ui/src/components/Button.test.tsx'),
  ).not.toContain('bolusi/no-hardcoded-strings');
});

test('no-token-literals covers packages/ui but exempts tokens.ts (§7 lint (a))', async () => {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
  const lintAt = async (source, filePath) => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.ruleId);
  };

  const rawHex = 'const s = StyleSheet.create({ box: { backgroundColor: "#1D4ED8" } });\n';
  const rawDp = 'const s = StyleSheet.create({ box: { height: 56 } });\n';
  const viaToken = 'const s = StyleSheet.create({ box: { height: touch.primary } });\n';

  expect(await lintAt(rawHex, 'packages/ui/src/components/Button.tsx')).toContain(
    'bolusi/no-token-literals',
  );
  expect(await lintAt(rawDp, 'packages/ui/src/components/Button.tsx')).toContain(
    'bolusi/no-token-literals',
  );
  expect(await lintAt(viaToken, 'packages/ui/src/components/Button.tsx')).not.toContain(
    'bolusi/no-token-literals',
  );
  // tokens.ts IS the vocabulary — exempt.
  expect(await lintAt(rawHex, 'packages/ui/src/tokens.ts')).not.toContain(
    'bolusi/no-token-literals',
  );
});
