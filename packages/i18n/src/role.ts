// Derived role copy (07-i18n §7; 02-permissions §12).
//
// A role's display name is mechanically derived from its plaintext roleKey — `role.<roleKey>.name`
// — exactly as `translateRejectionCode` derives `core.rejection.<CODE>`. There is deliberately no
// hand-written `{roleKey → key}` table: a map would let the roleKey enum and the `role/` catalog
// drift out of lockstep behind the §7.3 parity gate's back. The switcher card (design-system §8.2)
// renders whatever `resolveDisplayRoleKeys` returns, so a key with no catalog row — a future custom
// role — renders NO role line (`null`), not a placeholder, while logging once so the missing row is
// surfaced rather than silently blank.
import type { TranslationKey } from './generated/keys.js';
import { DEFAULT_LOCALE } from './locale.js';
import { warnOnce } from './logger.js';
import { hasKey, t } from './t.js';

/**
 * Render a plaintext roleKey (02-permissions §12: `main_owner` | `store_owner` | `staff`, or a
 * future custom role) as its localized display name, or `null` when no catalog row exists for it —
 * the caller omits the role line rather than showing a garbage key. Mirrors
 * `translateRejectionCode`'s mechanical-derivation-plus-probe (07-i18n §4.3).
 */
export function translateRoleKey(roleKey: string): string | null {
  const key = `role.${roleKey}.name`;
  // Probe the source locale: a roleKey absent there is absent everywhere (parity gate, §7.3).
  if (!hasKey(key, DEFAULT_LOCALE)) {
    warnOnce(`unknown-role:${key}`, `i18n: unknown roleKey '${roleKey}'; rendering no role line`, {
      roleKey,
      key,
    });
    return null;
  }
  return t(key as TranslationKey);
}
