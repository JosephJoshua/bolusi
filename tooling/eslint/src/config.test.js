import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

import config, { bolusi } from './index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('all bolusi custom rules are registered at error in the flat config', () => {
  // `no-token-literals` added task 23 (design-system §7 lint (a)).
  // `permission-module-prefix` added task 09 (02-permissions §2 CI lint).
  // `no-clock-in-handlers` + `runtime-emission-allowlist` added task 10 (04-module-contract
  // §5.1/§5.2).
  expect(Object.keys(bolusi.rules).sort()).toEqual([
    'boundaries',
    'no-clock-in-handlers',
    'no-float-money',
    'no-hardcoded-strings',
    'no-op-table-update',
    'no-token-literals',
    'permission-module-prefix',
    'runtime-emission-allowlist',
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
  expect(ruleLevel('bolusi/no-clock-in-handlers')).toBe('error');
  expect(ruleLevel('bolusi/runtime-emission-allowlist')).toBe('error');
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
    // T-14 (the guard asserts its own DENOMINATOR): pin the exact option key set, not just
    // the keys we happen to check. Asserting only known keys let the reviewer inject
    // `allowFloatDirs: ['packages/modules/src/']` — exempting ALL of packages/modules —
    // into both blocks plus the rule's meta.schema with every test still green. The rule's
    // `additionalProperties: false` already hard-fails an ACCIDENTAL new key (ESLint exits
    // 2, "Unexpected property"); what this line closes is the DELIBERATE two-file widening
    // (schema + config edited together), which is exactly how a carve-out gets quietly
    // broadened. A new option must be added here consciously.
    expect(Object.keys(options).sort()).toEqual([
      'allowFloatFiles',
      'allowFloatProps',
      'numericLiterals',
    ]);
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

// Added task 10. The two §5 rules, proven through the REAL flat config: the rule's own RuleTester
// fixtures prove it MATCHES, but only the config decides whether it ever runs on a real path.
test('no-clock-in-handlers fires on module command files and nowhere else (04 §5.2)', async () => {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
  const lintAt = async (source, filePath) => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.ruleId);
  };

  const clockInHandler = `export const commands = { c: { handler: (i, ctx) => ({ ops: [], at: Date.now() }) } };\n`;
  const pureHandler = `export const commands = { c: { handler: (i, ctx) => ({ ops: [ctx.op({ entityId: ctx.newId() })] }) } };\n`;

  // Where command handlers live — both file-naming conventions.
  expect(await lintAt(clockInHandler, 'packages/modules/src/notes/commands.ts')).toContain(
    'bolusi/no-clock-in-handlers',
  );
  expect(await lintAt(clockInHandler, 'packages/modules/src/notes/notes.commands.ts')).toContain(
    'bolusi/no-clock-in-handlers',
  );
  // A pure handler is clean — the rule is not simply always-on (T-14b).
  expect(await lintAt(pureHandler, 'packages/modules/src/notes/commands.ts')).not.toContain(
    'bolusi/no-clock-in-handlers',
  );
  // Screens legitimately read the clock — they are not handlers.
  expect(await lintAt(clockInHandler, 'packages/modules/src/notes/screens/List.tsx')).not.toContain(
    'bolusi/no-clock-in-handlers',
  );
  // So does the runtime itself: it is the one place that owns the stamp point.
  expect(await lintAt(clockInHandler, 'packages/core/src/runtime/execute.ts')).not.toContain(
    'bolusi/no-clock-in-handlers',
  );
});

test('runtime-emission-allowlist fires repo-wide on a non-command append (04 §5.1)', async () => {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
  const lintAt = async (source, filePath) => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.ruleId);
  };

  const unsanctioned = `await runtime.emitRuntimeOp({ type: 'notes.note_created', payload: {} });\n`;
  const sanctioned = `await runtime.emitRuntimeOp({ type: 'auth.session_ended', payload: {} });\n`;
  const directAppend = `await appendLocalOps({ store, drafts, context });\n`;

  // Prong A, wherever it is written — the rule is unscoped for a reason.
  for (const path of [
    'packages/modules/src/notes/commands.ts',
    'apps/mobile/src/screens/Notes.tsx',
    'packages/core/src/authz/denials.ts',
  ]) {
    expect(await lintAt(unsanctioned, path), path).toContain('bolusi/runtime-emission-allowlist');
  }
  // A sanctioned type is clean (T-14b).
  expect(await lintAt(sanctioned, 'packages/core/src/authz/denials.ts')).not.toContain(
    'bolusi/runtime-emission-allowlist',
  );

  // Prong B: the command runtime may reach the append path; nobody else may.
  expect(await lintAt(directAppend, 'packages/core/src/runtime/execute.ts')).not.toContain(
    'bolusi/runtime-emission-allowlist',
  );
  expect(await lintAt(directAppend, 'packages/modules/src/notes/commands.ts')).toContain(
    'bolusi/runtime-emission-allowlist',
  );
  expect(await lintAt(directAppend, 'apps/mobile/src/sneaky.ts')).toContain(
    'bolusi/runtime-emission-allowlist',
  );
});

// The config passes the closed set to the rule (so the rule holds no copy), which makes the config
// itself the second place the five are written. Anchor it to the SAME source of truth core's
// constant is pinned to — 04 §5.1 — so the two cannot drift apart without the spec moving.
test('the configured sanctioned set is exactly 04 §5.1`s five', () => {
  const doc = readFileSync(join(REPO_ROOT, 'ai-docs', '04-module-contract.md'), 'utf8');
  const [, afterHeading] = doc.split('**Sanctioned runtime emissions.**');
  expect(afterHeading, '04 §5.1 sanctioned-emissions paragraph not found').toBeDefined();
  const [paragraph] = afterHeading.split('\n\n');
  const fromSpec = [...paragraph.matchAll(/`(auth\.[a-z_]+)`/g)].map((m) => m[1]);

  // The parse's own denominator (T-14): a reformat that made this find 0 or 2 types would
  // otherwise let the comparison below pass against a starved list.
  expect(fromSpec, 'the §5.1 parse found the wrong number of types').toHaveLength(5);

  const block = config.find((b) => Array.isArray(b.rules?.['bolusi/runtime-emission-allowlist']));
  const configured = block.rules['bolusi/runtime-emission-allowlist'][1].sanctionedTypes;
  expect([...configured].sort()).toEqual([...fromSpec].sort());
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
