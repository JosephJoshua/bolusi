// Every 07-i18n §7.3 gate is proven by a failing fixture: a gate that cannot fail is not a gate.
// The real seed is asserted to pass each one, so the fixtures cannot be satisfied by a gate that
// simply rejects everything.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ALL_ERROR_CODES,
  DOMAIN_ERROR_CODES,
  MEDIA_ERROR_CODES,
  REJECTION_CODES,
} from '../scripts/error-code-registry.mjs';
import {
  checkBlankValues,
  checkCollision,
  checkErrorCodeCoverage,
  checkExtraction,
  checkIcuSubset,
  checkKeyGrammar,
  checkModuleCatalogCoverage,
  checkParity,
} from '../scripts/gates.mjs';
import { REPO_ROOT, loadReservedCatalogs } from '../scripts/catalog.mjs';

type Tree = Record<string, unknown>;

interface Source {
  id: string;
  namespace: string;
  locale: string;
  isModule?: boolean;
  tree: Tree;
}

const source = (
  namespace: string,
  locale: string,
  tree: Tree,
  extra: Partial<Source> = {},
): Source => ({
  id: `catalogs/${namespace}/${locale}.json`,
  namespace,
  locale,
  tree,
  ...extra,
});

/** The real, checked-in catalogs as gate input — the control for every fixture below. */
function realSources(): Source[] {
  return loadReservedCatalogs();
}

describe('error-code coverage gate (07-i18n §7.3)', () => {
  const errorsTree = (codes: string[]) => ({
    errors: Object.fromEntries(codes.map((code) => [code, `pesan ${code}`])),
    rejection: Object.fromEntries(REJECTION_CODES.map((code) => [code, `tolak ${code}`])),
  });

  it('fails, naming the code, when a DomainError code has no catalog row', () => {
    const missing = ALL_ERROR_CODES.filter((code) => code !== 'ROLE_IN_USE');
    const errors = checkErrorCodeCoverage([source('core', 'id', errorsTree(missing))]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ROLE_IN_USE');
    expect(errors[0]).toContain('core.errors.ROLE_IN_USE');
  });

  it('fails when a rejection code has no catalog row', () => {
    const tree = errorsTree(ALL_ERROR_CODES);
    delete (tree.rejection as Record<string, string>).CHAIN_HALTED;
    const errors = checkErrorCodeCoverage([source('core', 'id', tree)]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('CHAIN_HALTED');
  });

  it('passes on the full seed — DomainError, transport, media and all 8 rejection codes', () => {
    expect(DOMAIN_ERROR_CODES).toHaveLength(12);
    // 12 DomainError + IDEMPOTENCY_CONFLICT + RATE_LIMITED + 16 media (api/03 §8, task 18) +
    // UNEXPECTED = 31. MEDIA_ERROR_CODES surface through the same `core.errors.<CODE>` derivation
    // (06 §8); see error-code-registry.mjs for why they ride `core.*` and not `media.errors.*`.
    expect(MEDIA_ERROR_CODES).toHaveLength(16);
    expect(ALL_ERROR_CODES).toHaveLength(31);
    expect(REJECTION_CODES).toHaveLength(8);
    expect(checkErrorCodeCoverage(realSources())).toEqual([]);
  });

  it('ignores non-source locales — coverage is an `id` obligation', () => {
    expect(checkErrorCodeCoverage([source('core', 'en', errorsTree([]))])).not.toEqual([]);
  });
});

describe('key-grammar gate (07-i18n §3.1)', () => {
  it('fails a 2-segment key', () => {
    const errors = checkKeyGrammar([source('core', 'id', { save: 'Simpan' })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'core.save'");
    expect(errors[0]).toContain('2 segment');
  });

  it('fails a non-camelCase segment', () => {
    const errors = checkKeyGrammar([source('core', 'id', { Action: { save: 'Simpan' } })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'core.Action.save'");
  });

  it('passes the three §3.1 derived-key exceptions', () => {
    const errors = checkKeyGrammar([
      source('core', 'id', { rejection: { CHAIN_BROKEN: 'Riwayat rusak.' } }),
      source('permission', 'id', { notes: { create: { name: 'Buat catatan' } } }),
      source('role', 'id', { main_owner: { name: 'Pemilik Utama' } }),
    ]);
    expect(errors).toEqual([]);
  });

  it('still fails a derived error key whose code is not SCREAMING_SNAKE', () => {
    expect(checkKeyGrammar([source('core', 'id', { errors: { chainBroken: 'x' } })])).toHaveLength(
      1,
    );
  });

  it('fails a role key that is not one of the three seeded roles', () => {
    const errors = checkKeyGrammar([source('role', 'id', { super_admin: { name: 'x' } })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('super_admin');
  });

  it('passes the real seed', () => {
    expect(checkKeyGrammar(realSources())).toEqual([]);
  });

  it('lints module-owned catalog keys too — the reserved catalogs never carry them (§3.3)', () => {
    // A module namespace (`notes.*`) reaches this gate only through its own catalog file
    // (loadModuleCatalogs); the reserved catalogs never carry it. Since task 191 retired the
    // seed-doc gates, this is the sole proof the grammar linter covers module namespaces.
    expect(checkKeyGrammar([source('notes', 'id', { badKey: 'x' }, { isModule: true })])).toEqual([
      expect.stringContaining('notes.badKey'),
    ]);
  });

  it('flags the exact 2-segment keys task 30 renamed, whatever their namespace', () => {
    // Regression: these three once shipped as 2-segment keys. The grammar gate rejects them
    // wherever they live — a namespaced leaf must be at least 3 segments.
    const errors = checkKeyGrammar([
      source('auth', 'id', { switchStore: 'x' }),
      source('sync', 'id', { pullToRefresh: 'x' }),
      source('conflict', 'id', { banner: 'x' }),
    ]);
    expect(errors).toHaveLength(3);
    expect(errors.join('\n')).toContain('auth.switchStore');
    expect(errors.join('\n')).toContain('sync.pullToRefresh');
    expect(errors.join('\n')).toContain('conflict.banner');
    for (const error of errors) expect(error).toContain('2 segment');
  });
});

describe('collision gate (07-i18n §3.1, §7.3)', () => {
  it('fails when the same key is defined by two catalogs', () => {
    const errors = checkCollision([
      { ...source('core', 'id', { action: { save: 'Simpan' } }), id: 'catalogs/core/id.json' },
      {
        ...source('core', 'id', { action: { save: 'Simpan lagi' } }),
        id: 'catalogs/other/id.json',
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('core.action.save');
    expect(errors[0]).toContain('two catalogs');
  });

  it('fails when a module id equals a reserved namespace', () => {
    const errors = checkCollision([
      {
        ...source('sync', 'id', { list: { title: 'x' } }),
        id: 'packages/modules/sync/i18n/id.json',
        isModule: true,
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('reserved namespace');
  });

  it('allows a module owning its own namespace', () => {
    const errors = checkCollision([
      {
        ...source('notes', 'id', { list: { title: 'Catatan' } }),
        id: 'packages/modules/notes/i18n/id.json',
        isModule: true,
      },
    ]);
    expect(errors).toEqual([]);
  });

  it('does not treat the same key in different locales as a collision', () => {
    expect(
      checkCollision([
        source('core', 'id', { action: { save: 'Simpan' } }),
        source('core', 'en', { action: { save: 'Save' } }),
      ]),
    ).toEqual([]);
  });

  it('passes the real seed', () => {
    expect(checkCollision(realSources())).toEqual([]);
  });
});

describe('ICU subset gate (07-i18n §3.2)', () => {
  it('fails a forbidden ICU argument format', () => {
    const errors = checkIcuSubset([source('core', 'en', { money: { total: '{x, number}' } })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ICU argument formatting');
  });

  it('fails unparseable ICU', () => {
    const errors = checkIcuSubset([
      source('core', 'en', { time: { broken: '{count, plural, one {' } }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not parseable');
  });

  it('fails a plural block in an `id` value', () => {
    const errors = checkIcuSubset([
      source('core', 'id', {
        time: { minutesAgo: '{count, plural, one {# menit} other {# menit}}' },
      }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('one CLDR plural category');
  });

  it('allows the same plural block in `en`', () => {
    expect(
      checkIcuSubset([
        source('core', 'en', {
          time: { minutesAgo: '{count, plural, one {# minute ago} other {# minutes ago}}' },
        }),
      ]),
    ).toEqual([]);
  });

  it('catches the ASCII apostrophe that silently swallows ICU text', () => {
    const errors = checkIcuSubset([
      source('core', 'en', { errors: { X: "doesn't have '{count}' left" } }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ASCII apostrophe');
  });

  it('accepts the typographic apostrophe the catalog actually uses', () => {
    expect(
      checkIcuSubset([source('core', 'en', { errors: { X: 'doesn’t have {count} left' } })]),
    ).toEqual([]);
  });

  it('passes the real seed', () => {
    expect(checkIcuSubset(realSources())).toEqual([]);
  });
});

describe('parity gate (07-i18n §7.1, §7.3)', () => {
  it('fails when `en` lacks a key present in `id`', () => {
    const errors = checkParity([
      source('core', 'id', { action: { save: 'Simpan', cancel: 'Batal' } }),
      source('core', 'en', { action: { save: 'Save' } }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('core.action.cancel');
  });

  it('fails when `en` carries a key absent from `id` — id is the source language', () => {
    const errors = checkParity([
      source('core', 'id', { action: { save: 'Simpan' } }),
      source('core', 'en', { action: { save: 'Save', extra: 'Extra' } }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('core.action.extra');
  });

  it('does not fail on `zh` absence — scaffold-only, exempt in v0', () => {
    expect(
      checkParity([
        source('core', 'id', { action: { save: 'Simpan' } }),
        source('core', 'en', { action: { save: 'Save' } }),
      ]),
    ).toEqual([]);
  });

  it('does not fail on a partial `zh` catalog either', () => {
    expect(
      checkParity([
        source('core', 'id', { action: { save: 'Simpan' } }),
        source('core', 'en', { action: { save: 'Save' } }),
        source('core', 'zh', {}),
      ]),
    ).toEqual([]);
  });

  it('passes the real seed', () => {
    expect(checkParity(realSources())).toEqual([]);
  });
});

describe('blank-value gate (task 122, 165 — the leaf value is a usable label)', () => {
  it('flags an empty value, naming the file + key an author edits', () => {
    const errors = checkBlankValues([source('sync', 'id', { list: { title: '' } })]);
    expect(errors).toEqual([expect.stringContaining("key 'sync.list.title'")]);
  });

  it('flags a whitespace-only value too — it renders as blank chrome exactly like `` (trim)', () => {
    const errors = checkBlankValues([source('sync', 'en', { list: { title: '   ' } })]);
    expect(errors).toEqual([expect.stringContaining("key 'sync.list.title'")]);
    expect(errors[0]).toContain('(en)');
  });

  it('does NOT flag a legitimately short value — positive control (no false positive)', () => {
    // The predicate is trim() !== '', not a length floor: 'Ya'/'OK' are real labels.
    expect(checkBlankValues([source('core', 'id', { action: { ok: 'Ya' } })])).toEqual([]);
  });

  it('passes the real seed', () => {
    expect(checkBlankValues(realSources())).toEqual([]);
  });
});

describe('extraction gate (07-i18n §7.3)', () => {
  const sources = [source('auth', 'id', { pin: { title: 'Masukkan PIN' } })];

  it('fails on a t() key that is absent from the `id` catalog', () => {
    const { errors } = checkExtraction(['auth.pin.nonexistent'], sources);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('auth.pin.nonexistent');
  });

  it('warns — never fails — on an unused catalog key', () => {
    const { errors, warnings } = checkExtraction([], sources);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('auth.pin.title');
  });

  it('is silent when every used key exists', () => {
    expect(checkExtraction(['auth.pin.title'], sources)).toEqual({ errors: [], warnings: [] });
  });
});

// The registry is transcribed until task 10 lands the real one (see error-code-registry.mjs).
// Re-reading the specs here means a transcription slip fails CI rather than silently weakening
// the coverage gate it feeds.
describe('checked-in code registry mirrors the specs', () => {
  /** Slice a spec section, failing loudly if the doc's headings ever move. */
  function sectionBetween(doc: string, start: string, end: string): string {
    const [, afterStart] = doc.split(start);
    if (afterStart === undefined) throw new Error(`spec section '${start}' not found`);
    const [section] = afterStart.split(end);
    if (section === undefined) throw new Error(`spec section end '${end}' not found`);
    return section;
  }

  it('matches the DomainError closed set in 04-module-contract §5.3', () => {
    const doc = readFileSync(join(REPO_ROOT, 'ai-docs', '04-module-contract.md'), 'utf8');
    const section = sectionBetween(doc, '### 5.3', '## 6.');
    const codes = [...section.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1]);
    expect(codes).toEqual(DOMAIN_ERROR_CODES);
  });

  it('matches the rejection-code closed set in 05-operation-log §8', () => {
    const doc = readFileSync(join(REPO_ROOT, 'ai-docs', '05-operation-log.md'), 'utf8');
    const section = sectionBetween(doc, '## 8. Rejection codes', '## 9.');
    const codes = [...section.matchAll(/^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/gm)].map(
      (match) => match[1],
    );
    expect(codes).toEqual(REJECTION_CODES);
  });
});

describe('module catalog coverage (task 195)', () => {
  const notesCatalog = source(
    'notes',
    'id',
    { editor: { titleField: 'Judul' } },
    { isModule: true },
  );

  it('passes when every tn() namespace has a module catalog behind it', () => {
    expect(checkModuleCatalogCoverage(['notes'], 15, 1, [notesCatalog])).toEqual([]);
  });

  it('FAILS when a namespace is used by tn() but ships no catalog', () => {
    // The whole point: `sources` holds only catalogs that EXIST, so every other gate stays green
    // over the smaller set. Comparing against the namespaces the CODE uses is what finds this.
    const errors = checkModuleCatalogCoverage(['notes', 'inventory'], 20, 1, [notesCatalog]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("namespace 'inventory'");
  });

  it('FAILS when keys were found but no namespace came out of them', () => {
    // Found by the PR-5 test-quality review. The floor alone does not cover this: the count is
    // healthy (20, well above the floor) while the derived namespace list is empty, so the coverage
    // loop runs zero times and the function would return [] — a silent PASS over 20 unchecked keys.
    // Unreachable through check.mjs today (it derives both from one list), which is exactly why the
    // invariant needs asserting rather than assuming.
    const errors = checkModuleCatalogCoverage([], 20, 1, [notesCatalog]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ZERO namespaces were derived');
  });

  it('FAILS when the tn() scan collapses, instead of passing over an empty set', () => {
    // T-14 denominator guard. Without it a broken TN_CALL_RE yields no namespaces, the loop runs
    // zero times, and the gate reports PASS — indistinguishable from real coverage.
    const errors = checkModuleCatalogCoverage([], 0, 1, [notesCatalog]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('would pass over an empty set');
  });

  it('does not count a module catalog that contributes zero keys', () => {
    // A present-but-empty catalog would satisfy a does-the-directory-exist check while linting
    // nothing, so coverage is measured in KEYS, not in files.
    const empty = source('notes', 'id', {}, { isModule: true });
    const errors = checkModuleCatalogCoverage(['notes'], 15, 1, [empty]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("namespace 'notes'");
  });

  it('ignores reserved (non-module) catalogs when deciding coverage', () => {
    // A reserved catalog that happens to share the name must not discharge a module's obligation.
    const reserved = source('notes', 'id', { a: 'b' }, { isModule: false });
    expect(checkModuleCatalogCoverage(['notes'], 15, 1, [reserved])).toHaveLength(1);
  });
});
