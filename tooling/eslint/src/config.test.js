import { ESLint } from 'eslint';
import { expect, test } from 'vitest';
import config from './index.js';
test('repo-wide rules are not scoped to a files subset', () => {
  const repoWide = config.find(
    (block) => block.rules?.['bolusi/boundaries'] === 'error' && !block.files,
  );
  expect(repoWide).toBeDefined();
  expect(repoWide.rules['bolusi/no-op-table-update']).toBe('error');
});
test('no-float-money literal prong is scoped to schema files only (F1)', () => {
  const broad = config.find((block) => block.name === 'bolusi/money');
  expect(broad.rules['bolusi/no-float-money'][0]).toBe('error');
  expect(broad.rules['bolusi/no-float-money'][1].numericLiterals).toBe(false);
  expect(broad.files).toContain('packages/modules/src/**/*.{ts,tsx}');
  const schemaOnly = config.find((block) => block.name === 'bolusi/money-schema-files');
  expect(schemaOnly.rules['bolusi/no-float-money'][0]).toBe('error');
  expect(schemaOnly.rules['bolusi/no-float-money'][1].numericLiterals).toBe(true);
  expect(schemaOnly.files).toEqual([
    'packages/schemas/src/**/*.{ts,tsx}',
    'packages/modules/src/**/*.schema.{ts,tsx}',
    'packages/modules/src/**/{schema,schemas,ops,operations,commands,queries}.ts',
  ]);
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
    expect(Object.keys(options).sort()).toEqual([
      'allowFloatFiles',
      'allowFloatProps',
      'numericLiterals',
    ]);
    expect(options.allowFloatFiles).toEqual(['packages/schemas/src/envelope.ts']);
    expect(options.allowFloatProps).toEqual(['lat', 'lng', 'accuracyMeters']);
    expect(
      options.allowFloatProps.some((prop) => /(amount|price|cost|total|fee|idr)/i.test(prop)),
    ).toBe(false);
  }
  const [broadOptions, schemaOptions] = blocks.map(
    (block) => block.rules['bolusi/no-float-money'][1],
  );
  expect(broadOptions.allowFloatFiles).toEqual(schemaOptions.allowFloatFiles);
  expect(broadOptions.allowFloatProps).toEqual(schemaOptions.allowFloatProps);
});
const configWithoutTypeAwareLane = config.filter((block) => block.name !== 'bolusi/app-typed');
test('the type-aware lane covers apps/mobile/src with no-floating-promises (task 18)', () => {
  const lane = config.find((block) => block.name === 'bolusi/app-typed');
  expect(lane, 'bolusi/app-typed block must exist').toBeDefined();
  expect(lane.rules['@typescript-eslint/no-floating-promises']).toBe('error');
  expect(lane.languageOptions.parserOptions.projectService).toBe(true);
  expect(lane.files).toContain('apps/mobile/src/**/*.ts');
  expect(lane.files).toContain('apps/mobile/src/**/*.tsx');
  expect(lane.files).toContain('apps/server/src/**/*.ts');
});
test('direct Intl use fails outside packages/i18n and passes inside it (07-i18n §5)', async () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: configWithoutTypeAwareLane,
  });
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
test('no-hardcoded-strings now covers packages/ui but exempts its tests (§7 lint (b))', async () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: configWithoutTypeAwareLane,
  });
  const lintAt = async (source, filePath) => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.ruleId);
  };
  expect(
    await lintAt('const el = <Text>Simpan</Text>;\n', 'packages/ui/src/components/Button.tsx'),
  ).toContain('bolusi/no-hardcoded-strings');
  expect(
    await lintAt('const el = <Text>{label}</Text>;\n', 'packages/ui/src/components/Button.tsx'),
  ).not.toContain('bolusi/no-hardcoded-strings');
  expect(
    await lintAt('const el = <Text>Simpan</Text>;\n', 'packages/ui/src/components/Button.test.tsx'),
  ).not.toContain('bolusi/no-hardcoded-strings');
});
test('permission-module-prefix fires on real manifests and is exempted only in the assembly suite', async () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: configWithoutTypeAwareLane,
  });
  const lintAt = async (source, filePath) => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.ruleId);
  };
  const crossPrefix = `defineModule({ id: 'notes', permissions: { 'auth.user_create': { scope: 'store' } } });\n`;
  const crossModuleRequire = `defineModule({ id: 'notes', commands: { c: { permission: 'auth.user_create' } } });\n`;
  const ownPrefix = `defineModule({ id: 'notes', permissions: { 'notes.create': { scope: 'store' } }, commands: { c: { permission: 'notes.create' } } });\n`;
  expect(await lintAt(crossPrefix, 'packages/modules/src/notes/manifest.ts')).toContain(
    'bolusi/permission-module-prefix',
  );
  expect(await lintAt(crossModuleRequire, 'packages/modules/src/notes/manifest.ts')).toContain(
    'bolusi/permission-module-prefix',
  );
  expect(await lintAt(ownPrefix, 'packages/modules/src/notes/manifest.ts')).not.toContain(
    'bolusi/permission-module-prefix',
  );
  expect(await lintAt(crossPrefix, 'packages/core/test/authz/registry.test.ts')).not.toContain(
    'bolusi/permission-module-prefix',
  );
  expect(await lintAt(crossPrefix, 'packages/core/test/authz/evaluate.test.ts')).toContain(
    'bolusi/permission-module-prefix',
  );
  expect(await lintAt(crossPrefix, 'packages/core/src/authz/registry.ts')).toContain(
    'bolusi/permission-module-prefix',
  );
});
test('no-clock-in-handlers fires on module command files and nowhere else (04 §5.2)', async () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: configWithoutTypeAwareLane,
  });
  const lintAt = async (source, filePath) => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.ruleId);
  };
  const clockInHandler = `export const commands = { c: { handler: (i, ctx) => ({ ops: [], at: Date.now() }) } };\n`;
  const pureHandler = `export const commands = { c: { handler: (i, ctx) => ({ ops: [ctx.op({ entityId: ctx.newId() })] }) } };\n`;
  expect(await lintAt(clockInHandler, 'packages/modules/src/notes/commands.ts')).toContain(
    'bolusi/no-clock-in-handlers',
  );
  expect(await lintAt(clockInHandler, 'packages/modules/src/notes/notes.commands.ts')).toContain(
    'bolusi/no-clock-in-handlers',
  );
  expect(await lintAt(pureHandler, 'packages/modules/src/notes/commands.ts')).not.toContain(
    'bolusi/no-clock-in-handlers',
  );
  expect(await lintAt(clockInHandler, 'packages/modules/src/notes/screens/List.tsx')).not.toContain(
    'bolusi/no-clock-in-handlers',
  );
  expect(await lintAt(clockInHandler, 'packages/core/src/runtime/execute.ts')).not.toContain(
    'bolusi/no-clock-in-handlers',
  );
});
test('runtime-emission-allowlist fires repo-wide on a non-command append (04 §5.1)', async () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: configWithoutTypeAwareLane,
  });
  const lintAt = async (source, filePath) => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.ruleId);
  };
  const unsanctioned = `await runtime.emitRuntimeOp({ type: 'notes.note_created', payload: {} });\n`;
  const sanctioned = `await runtime.emitRuntimeOp({ type: 'auth.session_ended', payload: {} });\n`;
  const directAppend = `await appendLocalOps({ store, drafts, context });\n`;
  for (const path of [
    'packages/modules/src/notes/commands.ts',
    'apps/mobile/src/screens/Notes.tsx',
    'packages/core/src/authz/denials.ts',
  ]) {
    expect(await lintAt(unsanctioned, path), path).toContain('bolusi/runtime-emission-allowlist');
  }
  expect(await lintAt(sanctioned, 'packages/core/src/authz/denials.ts')).not.toContain(
    'bolusi/runtime-emission-allowlist',
  );
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
