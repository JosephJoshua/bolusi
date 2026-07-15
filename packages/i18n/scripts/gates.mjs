// The 07-i18n §7.3 CI gates, as pure functions over catalog sources so each one can be driven
// by a failing fixture in a unit test. All I/O lives in check.mjs.
import { TYPE, parse } from '@formatjs/icu-messageformat-parser';

import { ALL_ERROR_CODES, REJECTION_CODES } from './error-code-registry.mjs';
import { RESERVED_NAMESPACES } from './seed.mjs';

/**
 * A catalog source = one JSON file's worth of labels.
 * @typedef {object} CatalogSource
 * @property {string} id           provenance for error messages (e.g. 'catalogs/core/id.json')
 * @property {string} namespace    first key segment this file owns
 * @property {string} locale       'id' | 'en' | 'zh'
 * @property {boolean} [isModule]  true for module-owned catalogs (packages/modules/<id>/i18n)
 * @property {Record<string, unknown>} tree  nested object, namespace segment stripped
 */

/** The locale that is complete by definition and backs the fallback chain (07-i18n §6, §7.1). */
export const SOURCE_LOCALE = 'id';
/** Exempt from the parity gate in v0 — scaffold only (07-i18n §1, §7.1.3). */
export const PARITY_EXEMPT_LOCALES = ['zh'];

const CAMEL_SEGMENT = /^[a-z][a-zA-Z0-9]*$/;
const SCREAMING_SNAKE_SEGMENT = /^[A-Z][A-Z0-9_]*$/;
const SNAKE_SEGMENT = /^[a-z][a-z0-9_]*$/;
/** 01-domain-model §4.2 — the three seeded roles. */
const ROLE_KEYS = ['main_owner', 'store_owner', 'staff'];
const DERIVED_CORE_AREAS = ['errors', 'rejection'];
const PERMISSION_LEAVES = ['name', 'description'];

/**
 * Flatten a nested catalog tree into fully-qualified `namespace.a.b` entries.
 * @param {CatalogSource} source
 * @returns {{ key: string, value: string }[]}
 */
export function flattenSource(source) {
  /** @type {{ key: string, value: string }[]} */
  const out = [];
  /**
   * @param {Record<string, unknown>} node
   * @param {string[]} path
   */
  const walk = (node, path) => {
    for (const [segment, value] of Object.entries(node)) {
      const next = [...path, segment];
      if (value !== null && typeof value === 'object') {
        walk(/** @type {Record<string, unknown>} */ (value), next);
      } else {
        out.push({ key: next.join('.'), value: String(value) });
      }
    }
  };
  walk(source.tree, [source.namespace]);
  return out;
}

/**
 * Key grammar (07-i18n §3.1), including the two derived-key exception families.
 * @param {string} key
 * @returns {string | null} an explanation, or null when the key is legal
 */
export function keyGrammarError(key) {
  const segments = key.split('.');
  if (segments.length < 3) {
    return `has ${segments.length} segment(s); the grammar is <namespace>.<screen-or-area>.<label> (>= 3)`;
  }
  const [namespace, area] = segments;
  if (!CAMEL_SEGMENT.test(namespace)) {
    return `namespace segment '${namespace}' is not lowercase camelCase`;
  }

  // Exception — derived error keys: the final segment is the code verbatim (§3.1, §4.3).
  if (namespace === 'core' && DERIVED_CORE_AREAS.includes(area)) {
    if (segments.length !== 3) return `derived key 'core.${area}.<CODE>' takes exactly 3 segments`;
    return SCREAMING_SNAKE_SEGMENT.test(segments[2])
      ? null
      : `derived key segment '${segments[2]}' must be the SCREAMING_SNAKE code verbatim`;
  }

  // Exception — derived permission keys: permission.<module>.<action>.name|description (§3.1).
  if (namespace === 'permission') {
    if (segments.length !== 4) {
      return `derived permission key takes exactly 4 segments (permission.<module>.<action>.name|description)`;
    }
    for (const segment of segments.slice(1, 3)) {
      if (!SNAKE_SEGMENT.test(segment)) {
        return `permission id segment '${segment}' must match the registry id (snake_case)`;
      }
    }
    return PERMISSION_LEAVES.includes(segments[3])
      ? null
      : `permission key must end in ${PERMISSION_LEAVES.join(' or ')}, not '${segments[3]}'`;
  }

  // Exception — derived role keys: role.<roleKey>.name (§3.1).
  if (namespace === 'role') {
    if (segments.length !== 3)
      return `derived role key takes exactly 3 segments (role.<roleKey>.name)`;
    if (!ROLE_KEYS.includes(segments[1])) {
      return `'${segments[1]}' is not a seeded roleKey (${ROLE_KEYS.join(' | ')})`;
    }
    return segments[2] === 'name' ? null : `role key must end in 'name', not '${segments[2]}'`;
  }

  for (const segment of segments) {
    if (!CAMEL_SEGMENT.test(segment)) return `segment '${segment}' is not lowercase camelCase`;
  }
  return null;
}

/**
 * Gate: key grammar (07-i18n §7.3 "Collision check" row's grammar half, §3.1).
 * @param {CatalogSource[]} sources
 * @returns {string[]}
 */
export function checkKeyGrammar(sources) {
  const errors = [];
  for (const source of sources) {
    for (const { key } of flattenSource(source)) {
      const problem = keyGrammarError(key);
      if (problem) errors.push(`${source.id}: key '${key}' ${problem}`);
    }
  }
  return errors;
}

/**
 * Denominator floor for the seed-doc grammar gate (testing-guide T-14). ai-docs/ui-labels.md
 * carries 126 rows today; this floor sits below that so growth never trips it, while a starved
 * parse — a changed table format, a broken ROW_RE — fails loudly instead of linting nothing and
 * reporting green. Lower it only alongside a real, deliberate shrink of the seed.
 */
export const SEED_MIN_ROWS = 120;

/**
 * Gate: key grammar over the seed DOC itself (07-i18n §3.1, §7.3).
 *
 * Why this is separate from checkKeyGrammar: that gate reads catalog sources, which are seed
 * *output*. buildCatalogs drops every row in a module-owned namespace (`notes.*` — each module
 * ships its own catalog files, 07-i18n §3.3), so those rows land in no catalog and reach no
 * gate; before task 30 a parked-key list dropped three more. A key that never reaches a catalog
 * was never grammar-checked, so ui-labels.md could ship a name the grammar forbids and every
 * gate stayed green — the gate's denominator was 113 of 127 keys. This gate lints every row in
 * the doc whatever its namespace, and asserts it saw the whole doc (CLAUDE.md §2.11, T-14).
 *
 * @param {{ key: string }[]} rows every row parsed out of ai-docs/ui-labels.md
 * @param {number} [minRows] denominator floor; override only in tests
 * @returns {string[]}
 */
export function checkSeedKeyGrammar(rows, minRows = SEED_MIN_ROWS) {
  const errors = [];
  if (rows.length < minRows) {
    errors.push(
      `parsed only ${rows.length} row(s) out of ai-docs/ui-labels.md, expected >= ${minRows} — ` +
        `the parse is starved, so this gate checked almost nothing (testing-guide T-14). Fix the ` +
        `parse, or lower SEED_MIN_ROWS if the seed really did shrink.`,
    );
  }
  for (const { key } of rows) {
    const problem = keyGrammarError(key);
    if (problem) errors.push(`ai-docs/ui-labels.md: key '${key}' ${problem}`);
  }
  return errors;
}

/**
 * Gate: collisions — the same key defined by two catalogs, or a module claiming a reserved
 * namespace (07-i18n §3.1, §7.3).
 * @param {CatalogSource[]} sources
 * @returns {string[]}
 */
export function checkCollision(sources) {
  const errors = [];

  for (const source of sources) {
    if (source.isModule && RESERVED_NAMESPACES.includes(source.namespace)) {
      errors.push(
        `${source.id}: module id '${source.namespace}' collides with a reserved namespace (${RESERVED_NAMESPACES.join(', ')})`,
      );
    }
  }

  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const source of sources) {
    for (const { key } of flattenSource(source)) {
      const slot = `${source.locale}:${key}`;
      const existing = owner.get(slot);
      if (existing !== undefined && existing !== source.id) {
        errors.push(
          `key '${key}' (${source.locale}) is defined by two catalogs: ${existing} and ${source.id}`,
        );
      } else {
        owner.set(slot, source.id);
      }
    }
  }
  return errors;
}

/**
 * Gate: id/en parity — nobody merges id-only keys (07-i18n §7.1.2, §7.3). `zh` is exempt.
 * @param {CatalogSource[]} sources
 * @returns {string[]}
 */
export function checkParity(sources) {
  const errors = [];
  /** @type {Map<string, Map<string, Set<string>>>} */
  const byNamespace = new Map();
  for (const source of sources) {
    if (PARITY_EXEMPT_LOCALES.includes(source.locale)) continue;
    if (!byNamespace.has(source.namespace)) byNamespace.set(source.namespace, new Map());
    const byLocale = byNamespace.get(source.namespace);
    const keys = byLocale.get(source.locale) ?? new Set();
    for (const { key } of flattenSource(source)) keys.add(key);
    byLocale.set(source.locale, keys);
  }

  for (const [namespace, byLocale] of byNamespace) {
    const sourceKeys = byLocale.get(SOURCE_LOCALE);
    if (sourceKeys === undefined) {
      errors.push(
        `namespace '${namespace}' has no '${SOURCE_LOCALE}' catalog (id is the source language)`,
      );
      continue;
    }
    for (const [locale, keys] of byLocale) {
      if (locale === SOURCE_LOCALE) continue;
      for (const key of sourceKeys) {
        if (!keys.has(key))
          errors.push(`key '${key}' is in '${SOURCE_LOCALE}' but missing from '${locale}'`);
      }
      for (const key of keys) {
        if (!sourceKeys.has(key))
          errors.push(`key '${key}' is in '${locale}' but missing from '${SOURCE_LOCALE}'`);
      }
    }
  }
  return errors;
}

/**
 * Gate: ICU restricted subset (07-i18n §3.2, §7.3). Only interpolation, plural and select are
 * legal; ICU argument formatting is never allowed because it depends on the engine's ICU data,
 * and `id` has one CLDR plural category so a plural block there is always a mistake.
 * @param {CatalogSource[]} sources
 * @returns {string[]}
 */
export function checkIcuSubset(sources) {
  const errors = [];
  for (const source of sources) {
    for (const { key, value } of flattenSource(source)) {
      const where = `${source.id}: '${key}'`;

      // ICU treats ASCII ' as an escape character — it silently swallows following text.
      if (value.includes("'")) {
        errors.push(
          `${where} uses the ASCII apostrophe "'" (an ICU escape char); use the typographic '’' (§3.2)`,
        );
        continue;
      }

      let ast;
      try {
        ast = parse(value);
      } catch (error) {
        errors.push(`${where} is not parseable ICU MessageFormat: ${error.message}`);
        continue;
      }

      /** @param {any[]} nodes */
      const walk = (nodes) => {
        for (const node of nodes) {
          switch (node.type) {
            case TYPE.number:
            case TYPE.date:
            case TYPE.time:
              errors.push(
                `${where} uses ICU argument formatting ({${node.value}, ...}); dates/numbers/money are pre-formatted by the @bolusi/i18n formatters and passed in as strings (§3.2, §5)`,
              );
              break;
            case TYPE.tag:
              errors.push(
                `${where} contains markup (<${node.value}>); catalog values carry no markup (§3.2)`,
              );
              break;
            case TYPE.plural:
              if (source.locale === SOURCE_LOCALE) {
                errors.push(
                  `${where} uses a plural block in '${SOURCE_LOCALE}', which has one CLDR plural category — use plain {${node.value}} (§3.2)`,
                );
              }
              for (const option of Object.values(node.options ?? {})) walk(option.value);
              break;
            case TYPE.select:
              for (const option of Object.values(node.options ?? {})) walk(option.value);
              break;
            default:
              break;
          }
        }
      };
      walk(ast);
    }
  }
  return errors;
}

/**
 * Gate: error-code coverage — every DomainError code (04-module-contract §5.3) and every
 * rejection code (05-operation-log §8) has its derived catalog row (07-i18n §4.2, §4.3, §7.3).
 * @param {CatalogSource[]} sources
 * @param {{ errorCodes?: string[], rejectionCodes?: string[] }} [registry]
 * @returns {string[]}
 */
export function checkErrorCodeCoverage(sources, registry = {}) {
  const errorCodes = registry.errorCodes ?? ALL_ERROR_CODES;
  const rejectionCodes = registry.rejectionCodes ?? REJECTION_CODES;

  const present = new Set();
  for (const source of sources) {
    if (source.locale !== SOURCE_LOCALE) continue;
    for (const { key } of flattenSource(source)) present.add(key);
  }

  const errors = [];
  for (const code of errorCodes) {
    const key = `core.errors.${code}`;
    if (!present.has(key)) {
      errors.push(
        `DomainError code '${code}' has no '${key}' row (04-module-contract §5.3 + 07-i18n §4.2)`,
      );
    }
  }
  for (const code of rejectionCodes) {
    const key = `core.rejection.${code}`;
    if (!present.has(key)) {
      errors.push(
        `rejection code '${code}' has no '${key}' row (05-operation-log §8 + 07-i18n §4.3)`,
      );
    }
  }
  return errors;
}

/**
 * Gate: extraction — every `t()` key in code exists in the `id` catalog; unused catalog keys
 * are a warning only (07-i18n §7.3).
 * @param {string[]} usedKeys
 * @param {CatalogSource[]} sources
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkExtraction(usedKeys, sources) {
  const present = new Set();
  for (const source of sources) {
    if (source.locale !== SOURCE_LOCALE) continue;
    for (const { key } of flattenSource(source)) present.add(key);
  }

  const errors = [];
  for (const key of usedKeys) {
    if (!present.has(key))
      errors.push(`t('${key}') is used in code but absent from the '${SOURCE_LOCALE}' catalog`);
  }

  const used = new Set(usedKeys);
  const warnings = [];
  for (const key of present) {
    if (!used.has(key)) warnings.push(`catalog key '${key}' is not referenced by any t() call`);
  }
  return { errors, warnings };
}
