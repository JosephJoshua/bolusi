import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

import config, { bolusi } from './index.js';

test('all bolusi custom rules are registered at error in the flat config', () => {
  // `no-token-literals` added task 23 (design-system §7 lint (a)).
  // `permission-module-prefix` added task 09 (02-permissions §2 CI lint).
  expect(Object.keys(bolusi.rules).sort()).toEqual([
    'boundaries',
    'no-float-money',
    'no-hardcoded-strings',
    'no-op-table-update',
    'no-token-literals',
    'permission-module-prefix',
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
  expect(ruleLevel('bolusi/permission-module-prefix')).toBe('error');
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
  expect(broad.rules['bolusi/no-float-money']).toEqual(['error', { numericLiterals: false }]);
  expect(broad.files).toContain('packages/modules/src/**/*.{ts,tsx}');

  const schemaOnly = config.find((block) => block.name === 'bolusi/money-schema-files');
  expect(schemaOnly.rules['bolusi/no-float-money']).toEqual(['error', { numericLiterals: true }]);
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

// Added task 09. The 02-permissions §2 lint is repo-wide, and its ONE exemption is the assembly
// suite that must construct a rejected manifest to prove it is rejected. An exemption that
// silently covered more than that file would disarm the lint for real manifests, so the scope is
// asserted through the REAL flat config rather than by reading the config object back.
test('permission-module-prefix fires on real manifests and is exempted only in the assembly suite', async () => {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
  const lintAt = async (source, filePath) => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.ruleId);
  };

  const crossPrefix = `defineModule({ id: 'notes', permissions: { 'auth.user_create': { scope: 'store' } } });\n`;
  const crossModuleRequire = `defineModule({ id: 'notes', commands: { c: { permission: 'auth.user_create' } } });\n`;
  const ownPrefix = `defineModule({ id: 'notes', permissions: { 'notes.create': { scope: 'store' } }, commands: { c: { permission: 'notes.create' } } });\n`;

  // Where module manifests actually live — both prongs fire.
  expect(await lintAt(crossPrefix, 'packages/modules/src/notes/manifest.ts')).toContain(
    'bolusi/permission-module-prefix',
  );
  expect(await lintAt(crossModuleRequire, 'packages/modules/src/notes/manifest.ts')).toContain(
    'bolusi/permission-module-prefix',
  );
  // A correct manifest is clean (T-14b: the rule is not simply always-on).
  expect(await lintAt(ownPrefix, 'packages/modules/src/notes/manifest.ts')).not.toContain(
    'bolusi/permission-module-prefix',
  );

  // The exemption covers the assembly suite...
  expect(await lintAt(crossPrefix, 'packages/core/test/authz/registry.test.ts')).not.toContain(
    'bolusi/permission-module-prefix',
  );
  // ...and NOTHING else — not core src, not core's other authz tests.
  expect(await lintAt(crossPrefix, 'packages/core/test/authz/evaluate.test.ts')).toContain(
    'bolusi/permission-module-prefix',
  );
  expect(await lintAt(crossPrefix, 'packages/core/src/authz/registry.ts')).toContain(
    'bolusi/permission-module-prefix',
  );
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
