// The `platform` module's vocabulary (01-domain-model §6 — the authoritative platform op list).
//
// One home for the strings the module, the server's detection engine, and the tests all name. They
// are spec-fixed (01 §6, 02 §11.3, 07-i18n §1.1); a literal retyped at a call site is how a fold
// silently stops matching the op that feeds it.

/** Lowercase module id (04 §1) — prefixes every op type and permission below. */
export const PLATFORM_MODULE_ID = 'platform';

/** The complete `platform` op-type set (01 §6). No other module registers these. */
export const PLATFORM_OP = {
  /** System-device only, server-built inside the push transaction (01 §3.6, 10-db §3). */
  conflictDetected: 'platform.conflict_detected',
  /** Owner command `acknowledgeConflict` (01 §6). */
  conflictAcknowledged: 'platform.conflict_acknowledged',
  /** Command `platform.setLocale`, tenant-scoped (01 §6; 07-i18n §1.1). */
  userLocaleChanged: 'platform.user_locale_changed',
} as const;

/** The entity types the platform ops carry (01 §6). */
export const PLATFORM_ENTITY = {
  /** `conflict_detected` (new id) AND `conflict_acknowledged` (that id) — ONE entity, two ops. */
  conflict: 'conflict',
  /** `user_locale_changed` — entityId is the acting user (07-i18n §1.1). */
  userPref: 'user_pref',
} as const;

/** The permission ids the platform surfaces require (02-permissions §11.3). */
export const PLATFORM_PERMISSION = {
  conflictView: 'platform.conflict_view',
  conflictAcknowledge: 'platform.conflict_acknowledge',
  setLocale: 'platform.set_locale',
} as const;

/** Physical projection table names (10-db §8 / §9.6 — identical on both engines). */
export const CONFLICTS_TABLE = 'conflicts';
export const USER_PREFS_TABLE = 'user_prefs';

/**
 * Conflict severity (01 §8.3). Static per op type — declared, never derived from a payload.
 *
 * Re-exported from the module contract rather than redeclared: the `conflicts.severity` column and
 * an op type's `conflict.severity` declaration are the same vocabulary, and two enums would be two
 * answers (CLAUDE.md §2.8).
 */
export type { ConflictSeverity } from '../module/define-module.js';

/**
 * Conflict lifecycle states (01 §5.4, 03-state-machines §7).
 *
 * `detected` is TRANSIENT — "classification happens in the same transaction that creates the
 * record", so it is never at rest. It is in the type (and in both engines' CHECK constraints)
 * because a crash could persist one, and 03 §7's self-loop re-classifies it on the next engine run.
 */
export type ConflictStatus = 'detected' | 'auto_resolved' | 'surfaced' | 'acknowledged';

/**
 * The resting status a severity classifies to (01 §8.3 / 03 §7's two `detected` transitions).
 *
 * THE WHOLE OF THE CLASSIFICATION RULE, in one total function — which is why it is a function and
 * not two `if`s at the applier. 03 §7 gives `detected` exactly two exits and this is both of them;
 * a third caller deciding it independently is how one path starts surfacing minor conflicts.
 */
export function restingStatusFor(severity: 'minor' | 'significant'): ConflictStatus {
  // minor → auto_resolved (terminal; recorded for reporting, nobody is asked anything).
  // significant → surfaced (a store owner must see it, and acknowledge it).
  return severity === 'minor' ? 'auto_resolved' : 'surfaced';
}

// The locales `platform.setLocale` / `platform.user_locale_changed` accept (07-i18n §1.1) are NOT
// declared here. They are `SELECTABLE_LOCALES`, imported from `@bolusi/schemas` — the ONE list the
// in-app toggle (@bolusi/i18n) reads too, so the op enum and the toggle cannot drift (CLAUDE.md
// §2.8). See `commands.ts` / `operations.ts` and `@bolusi/schemas/src/locale.ts` (task 77; this used
// to be a second hardcoded `LOCALE_VALUES` copy).
