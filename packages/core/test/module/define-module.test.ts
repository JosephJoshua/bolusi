// `defineModule` manifest validation (04-module-contract §1/§3/§4.4).
//
// Every defect is a STARTUP FAILURE naming the offending key (04 §3 has no warning state). One
// behaviour per test (T-2), unique seeded values per case (T-3), and every rejection test starts
// from `validManifest(seed)` and breaks exactly one thing — so a red test names its own cause.
import { describe, expect, test } from 'vitest';

import { defineModule, ModuleDefinitionError } from '../../src/index.js';
import {
  moduleIdFor,
  passthroughSchema,
  strictSchema,
  strippingSchema,
  validManifest,
  widgetsTable,
  type FixtureSuiteDatabase,
} from './_fixtures.js';

/** Define a manifest, expecting `ModuleDefinitionError` whose message names `mentions`. */
function expectRejected(build: () => unknown, ...mentions: string[]): ModuleDefinitionError {
  let error: unknown;
  try {
    build();
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof ModuleDefinitionError)) {
    throw new Error(`expected ModuleDefinitionError, got ${String(error)}`);
  }
  for (const mention of mentions) {
    // The message must NAME the offending key — a validator that says "invalid manifest" sends the
    // author hunting through a file (04 §3: the error names the key).
    expect(error.message).toContain(mention);
  }
  return error;
}

describe('op type format (04 §3: <moduleId>.<entity>_<event-past-tense>)', () => {
  test('rejects an op type whose prefix is not the declaring module id', () => {
    const seed = 101;
    const manifest = validManifest(seed);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          operations: {
            'otherprefix.widget_created':
              manifest.operations[`${moduleIdFor(seed)}.widget_created`]!,
          },
        }),
      'otherprefix.widget_created',
      moduleIdFor(seed),
    );
  });

  test('rejects an op type containing uppercase', () => {
    const seed = 102;
    const manifest = validManifest(seed);
    const id = moduleIdFor(seed);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          operations: { [`${id}.widget_Created`]: manifest.operations[`${id}.widget_created`]! },
        }),
      'widget_Created',
    );
  });

  test('rejects a present-tense op type', () => {
    // The mistake this rule exists for: `widget_create` is a PERMISSION's grammar (02 §2, present
    // tense) on an op type (04 §3, past tense). Nothing else in the system would catch it — the two
    // registries never meet.
    const seed = 103;
    const manifest = validManifest(seed);
    const id = moduleIdFor(seed);

    const error = expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          operations: { [`${id}.widget_create`]: manifest.operations[`${id}.widget_created`]! },
        }),
      `${id}.widget_create`,
    );
    expect(error.message).toContain('past-tense');
  });

  test('rejects an op type with no <entity>_<event> split', () => {
    const seed = 104;
    const manifest = validManifest(seed);
    const id = moduleIdFor(seed);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          operations: { [`${id}.created`]: manifest.operations[`${id}.widget_created`]! },
        }),
      `${id}.created`,
    );
  });

  test('accepts an irregular past form the v0 corpus actually uses (pin_reset)', () => {
    // NOT a hypothetical: `auth.pin_reset` is a real v0 op type (02 §4's push-validated privileged
    // PIN ops). A naive "ends in -ed" rule rejects it and task 13 cannot boot. This is why the rule
    // was derived from the enumerated corpus rather than from remembered examples (T-12).
    const manifest = validManifest(105);
    const withIrregular = {
      ...manifest,
      id: 'auth',
      operations: { 'auth.pin_reset': manifest.operations[`${moduleIdFor(105)}.widget_created`]! },
      permissions: {},
      commands: {},
      queries: {},
    };

    expect(() =>
      defineModule<FixtureSuiteDatabase, typeof withIrregular>(withIrregular),
    ).not.toThrow();
  });

  test('accepts a past-tense verb followed by a particle (pin_locked_out)', () => {
    // Also real: `auth.pin_locked_out` is one of the five sanctioned runtime emissions (04 §5.1).
    // Its LAST word is a particle, not a verb — a naive last-word rule rejects it.
    const manifest = validManifest(106);
    const withParticle = {
      ...manifest,
      id: 'auth',
      operations: {
        'auth.pin_locked_out': manifest.operations[`${moduleIdFor(106)}.widget_created`]!,
      },
      permissions: {},
      commands: {},
      queries: {},
    };

    expect(() =>
      defineModule<FixtureSuiteDatabase, typeof withParticle>(withParticle),
    ).not.toThrow();
  });

  test('rejects a present-tense type whose last word is a noun (user_reset_pin)', () => {
    // The near-miss the particle walk must NOT swallow: `reset` is an allowlisted irregular, so a
    // rule that scanned for "any past-tense word anywhere" would accept this permission-shaped
    // name. The rule checks the LAST non-particle word, so it does not.
    const manifest = validManifest(107);
    const id = moduleIdFor(107);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          operations: { [`${id}.user_reset_pin`]: manifest.operations[`${id}.widget_created`]! },
        }),
      `${id}.user_reset_pin`,
    );
  });
});

describe('reversal (04 §3: MANDATORY)', () => {
  test('rejects a missing reversal', () => {
    const seed = 111;
    const manifest = validManifest(seed);
    const id = moduleIdFor(seed);
    const declaration = manifest.operations[`${id}.widget_created`]!;
    const withoutReversal = {
      schemaVersion: declaration.schemaVersion,
      payload: declaration.payload,
      apply: declaration.apply,
    };

    const error = expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          operations: { [`${id}.widget_created`]: withoutReversal as never },
        }),
      `${id}.widget_created`,
    );
    expect(error.message).toContain('reversal');
  });

  test('rejects an empty reversal', () => {
    // Whitespace-only counts as empty: a `reversal: '   '` satisfies "the field is present" and
    // answers nothing, which is the one thing the mandatory field exists to prevent.
    const seed = 112;
    const manifest = validManifest(seed);
    const id = moduleIdFor(seed);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          operations: {
            [`${id}.widget_created`]: {
              ...manifest.operations[`${id}.widget_created`]!,
              reversal: '   ',
            },
          },
        }),
      'reversal',
    );
  });
});

describe('payload .strict() (04 §3)', () => {
  test('rejects a payload schema that strips unknown keys (zod default)', () => {
    const seed = 121;
    const manifest = validManifest(seed);
    const id = moduleIdFor(seed);

    const error = expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          operations: {
            [`${id}.widget_created`]: {
              ...manifest.operations[`${id}.widget_created`]!,
              payload: strippingSchema(),
            },
          },
        }),
      `${id}.widget_created`,
    );
    expect(error.message).toContain('.strict()');
  });

  test('rejects a payload schema that passes unknown keys through', () => {
    const seed = 122;
    const manifest = validManifest(seed);
    const id = moduleIdFor(seed);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          operations: {
            [`${id}.widget_created`]: {
              ...manifest.operations[`${id}.widget_created`]!,
              payload: passthroughSchema(),
            },
          },
        }),
      '.strict()',
    );
  });
});

describe('schemaVersion (04 §3)', () => {
  test.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '1'],
  ])('rejects schemaVersion that is %s', (_label, value) => {
    // The CLASS, enumerated (T-12): "integer >= 1" has four distinct ways to be false and a
    // hand-picked example would cover one. `1.5` is the interesting one — `typeof === 'number'`
    // and `>= 1`, so only the integer check catches it.
    const seed = 130 + String(_label).length;
    const manifest = validManifest(seed);
    const id = moduleIdFor(seed);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          operations: {
            [`${id}.widget_created`]: {
              ...manifest.operations[`${id}.widget_created`]!,
              schemaVersion: value as never,
            },
          },
        }),
      'schemaVersion',
    );
  });
});

describe('projections (04 §4.4)', () => {
  test('rejects an entityIdColumn that is not among the declared columns', () => {
    // The §4.2 re-fold DELETES by this column. Naming a column that does not exist makes the delete
    // match nothing, so a re-fold DUPLICATES rows instead of replacing them — a convergence bug
    // that presents as an applier bug.
    const seed = 141;
    const manifest = validManifest(seed);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          projections: {
            tables: {
              [`${moduleIdFor(seed)}_widgets`]: {
                ...widgetsTable(),
                entityIdColumn: 'nonexistent_col',
              },
            },
          },
        }),
      'nonexistent_col',
    );
  });

  test('rejects a table with no declared columns', () => {
    const seed = 142;
    const manifest = validManifest(seed);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          projections: {
            tables: { [`${moduleIdFor(seed)}_widgets`]: { ...widgetsTable(), columns: {} } },
          },
        }),
      'columns',
    );
  });
});

describe('permissions + surfaces (02 §2/§3.2 rule 4; 04 §5/§6)', () => {
  test('rejects a permission id declared under another module’s prefix', () => {
    const seed = 151;
    const manifest = validManifest(seed);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          permissions: {
            'notmine.create': { scope: 'store', isDangerous: false, description: 'Not mine.' },
          },
        }),
      'notmine.create',
    );
  });

  test('rejects a command that declares no permission', () => {
    // There is no unchecked surface (02 §4). A command with no `permission` would make the single
    // enforcement point a no-op for that command specifically.
    const seed = 152;
    const manifest = validManifest(seed);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          commands: {
            createWidget: { input: strictSchema(), handler: () => ({ ops: [] }) } as never,
          },
        }),
      'createWidget',
      'permission',
    );
  });

  test('rejects a query that declares no permission', () => {
    const seed = 153;
    const manifest = validManifest(seed);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          queries: {
            listWidgets: {
              input: strictSchema(),
              handler: () => ({ rows: [], nextCursor: null }),
            } as never,
          },
        }),
      'listWidgets',
      'permission',
    );
  });
});

describe('module id (04 §1)', () => {
  test.each([
    ['uppercase', 'MyModule'],
    ['dotted', 'my.module'],
    ['snake_case', 'my_module'],
    ['leading digit', '1notes'],
    ['empty', ''],
  ])('rejects a %s module id', (_label, id) => {
    const manifest = validManifest(160 + String(_label).length);

    expectRejected(
      () =>
        defineModule<FixtureSuiteDatabase, typeof manifest>({
          ...manifest,
          id,
          operations: {},
          permissions: {},
          commands: {},
          queries: {},
        }),
      'module id',
    );
  });
});

describe('a valid manifest is accepted and returned unchanged', () => {
  test('accepts a fully valid manifest', () => {
    const manifest = validManifest(171);

    expect(() => defineModule<FixtureSuiteDatabase, typeof manifest>(manifest)).not.toThrow();
  });

  test('carries every declared member through BY REFERENCE (no cloning surprises)', () => {
    // "Returned unchanged" in the sense that matters: the applier, handler and schema objects the
    // author wrote are the SAME objects the runtime uses. A defensive deep-clone would produce
    // handlers that are `==` to nothing, breaking identity comparisons and quietly detaching any
    // closure state a module relied on.
    const seed = 172;
    const manifest = validManifest(seed);
    const id = moduleIdFor(seed);

    const module = defineModule<FixtureSuiteDatabase, typeof manifest>(manifest);

    expect(module.id).toBe(manifest.id);
    expect(module.operations).toBe(manifest.operations);
    expect(module.operations[`${id}.widget_created`]!.apply).toBe(
      manifest.operations[`${id}.widget_created`]!.apply,
    );
    expect(module.projections).toBe(manifest.projections);
    expect(module.permissions).toBe(manifest.permissions);
    // Bracket access with a cast: `validManifest` is declared as `ModuleManifest<Db>` (its keys are
    // built from the seed), so the mapped literal-key type cannot apply here. The fixture module's
    // round-trip suite exercises the typed form, where the keys ARE literals.
    const commands = module.commands as Record<string, { handler: unknown }>;
    const queries = module.queries as Record<string, { handler: unknown }>;
    expect(commands.createWidget!.handler).toBe(manifest.commands!.createWidget!.handler);
    expect(queries.listWidgets!.handler).toBe(manifest.queries!.listWidgets!.handler);
  });

  test('does not mutate the input manifest', () => {
    // `defineModule` attaches `name` to commands/queries. It must do that on new objects: mutating
    // the author's literal would make a module manifest change shape merely by being defined —
    // and a second `defineModule` call would then see a different input than the first.
    const manifest = validManifest(173);

    defineModule<FixtureSuiteDatabase, typeof manifest>(manifest);

    expect(manifest.commands!.createWidget).not.toHaveProperty('name');
    expect(manifest.queries!.listWidgets).not.toHaveProperty('name');
  });

  test('derives each command/query `name` from its manifest key', () => {
    // The denial op's `target` (02 §7) names what was attempted, and it comes from here. Declaring
    // the name twice (key + field) is how the two drift.
    const manifest = validManifest(174);

    const module = defineModule<FixtureSuiteDatabase, typeof manifest>(manifest);

    const commands = module.commands as Record<string, { name: string }>;
    const queries = module.queries as Record<string, { name: string }>;
    expect(commands.createWidget!.name).toBe('createWidget');
    expect(queries.listWidgets!.name).toBe('listWidgets');
  });
});
