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
