// Derived error/rejection copy (07-i18n §4.2, §4.3).
//
// The key is mechanically derived from the code — there is no hand-written mapping table here,
// and adding one would defeat the coverage gate (§7.3) that keeps the registries and the catalog
// in lockstep. A `DomainError`'s `message` is developer-facing English for logs and is never
// rendered; the `code` is the contract.
import type { TranslationKey } from './generated/keys.js';
import { DEFAULT_LOCALE } from './locale.js';
import { warnOnce } from './logger.js';
import { hasKey, t, type TranslationValues } from './t.js';

/** Rendered for any code with no catalog row (§4.2, §6). */
const FALLBACK_ERROR_KEY = 'core.errors.UNEXPECTED' satisfies TranslationKey;

/** Rendered for any op type whose owning module ships no `opType.<verb>` label (§4.4). */
const FALLBACK_OP_TYPE_KEY = 'core.opType.unknown' satisfies TranslationKey;

/**
 * @param prefix derived-key area, `errors` or `rejection`
 * @param code the SCREAMING_SNAKE code, used verbatim as the final segment (§3.1)
 */
function translateCode(prefix: 'errors' | 'rejection', code: string, values?: TranslationValues) {
  const key = `core.${prefix}.${code}`;

  // Probe the source locale: a code absent there is absent everywhere (parity gate, §7.3).
  if (!hasKey(key, DEFAULT_LOCALE)) {
    warnOnce(
      `unknown-code:${key}`,
      `i18n: unknown ${prefix} code '${code}'; rendering UNEXPECTED`,
      {
        code,
        key,
      },
    );
    return t(FALLBACK_ERROR_KEY);
  }
  return t(key as TranslationKey, values);
}

/**
 * Render a `DomainError` code (04-module-contract §5.3) as user-facing copy.
 * An unknown code renders `core.errors.UNEXPECTED` and logs (§4.2).
 */
export function translateErrorCode(code: string, values?: TranslationValues): string {
  return translateCode('errors', code, values);
}

/**
 * Render a sync rejection code (05-operation-log §8) for the rejected-changes screen.
 * The server's `rejectionReason` is diagnostic detail shown in a collapsed "technical details"
 * section, untranslated — never the primary message (§4.3).
 */
export function translateRejectionCode(code: string, values?: TranslationValues): string {
  return translateCode('rejection', code, values);
}

/**
 * Render an operation type (05-operation-log §3, e.g. `notes.note_created`) as a human label for the
 * Sync Status rejected-changes list.
 *
 * The key is derived mechanically as `<module>.opType.<camelVerb>` — the module prefix verbatim, the
 * snake-case verb camelCased to satisfy the segment grammar (§3.1) — and resolves against whatever
 * catalog owns that namespace (07-i18n §3.3). An op type with no matching row renders
 * `core.opType.unknown` and logs once (§4.4), mirroring `translateCode`'s unknown-code path.
 *
 * THE LABEL LIVES WHERE ITS NAMESPACE LIVES — there is no op-type-specific rule (D28). A reserved,
 * platform-owned namespace (`auth`, `platform`) carries its rows in this package's own catalogs; a
 * module that ships a catalog (`notes`) carries them there. This docstring previously said the
 * opposite — "MODULE-PROVIDED, not owned here… deliberately no op-type→label table in this package"
 * — and that rule is what produced task 212: `auth` and `platform` declare 11 op types between them
 * and ship no catalog, so the rule did not say where their labels belonged, it said nowhere, and all
 * 11 rendered the fallback on a live screen. Resolving by namespace needs no new mechanism.
 *
 * `apps/mobile/test/op-type-labels.test.ts` enumerates `ALL_MODULES`' declared operations and fails
 * on any type without a row, so this is enforced rather than remembered.
 */
export function translateOpType(type: string, values?: TranslationValues): string {
  const dot = type.indexOf('.');
  if (dot > 0) {
    const module = type.slice(0, dot);
    const verb = type.slice(dot + 1).replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    const key = `${module}.opType.${verb}`;
    // Probe the source locale: a key absent there is absent everywhere (parity gate, §7.3).
    if (hasKey(key, DEFAULT_LOCALE)) {
      return t(key as TranslationKey, values);
    }
  }
  warnOnce(`unknown-op-type:${type}`, `i18n: unknown op type '${type}'; rendering unknown`, {
    type,
  });
  return t(FALLBACK_OP_TYPE_KEY);
}
