// Derived role copy (07-i18n §7; 02-permissions §12).
//
// A preset role's display name is mechanically derived from its plaintext roleKey —
// `role.<roleKey>.name` — exactly as `translateRejectionCode` derives `core.rejection.<CODE>`. There
// is deliberately no hand-written `{roleKey → key}` table: a map would let the roleKey enum and the
// `role/` catalog drift out of lockstep behind the §7.3 parity gate's back.
//
// A role the main owner made in the role editor has no catalog row: its roleKey IS the name they
// typed ("Kasir senior"), and the server never lets a made role take a preset's key, so a key with
// no row is shown as it is.
import type { TranslationKey } from './keys.js';
import { DEFAULT_LOCALE } from './locale.js';
import { hasKey, t } from './t.js';

/** Whether this roleKey is a preset's, with its own copy (not a name someone typed). */
export function isPresetRoleKey(roleKey: string): boolean {
  // Probe the source locale: a roleKey absent there is absent everywhere (parity gate, §7.3).
  return hasKey(`role.${roleKey}.name`, DEFAULT_LOCALE);
}

/** A role's display name: a preset's localized name, or a made role's own. */
export function translateRoleKey(roleKey: string): string {
  return isPresetRoleKey(roleKey) ? t(`role.${roleKey}.name` as TranslationKey) : roleKey;
}
