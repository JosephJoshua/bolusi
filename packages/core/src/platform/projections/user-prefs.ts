// The `user_prefs` projection (07-i18n §1.1; 01 §7) — the fold at the centre of task 49's finding.
//
// ── WHY THIS FILE IS THE ONE THAT MATTERS ─────────────────────────────────────────────────────
//
// Task 21 composes push-notification locale by READING `user_prefs`. Nothing wrote that table
// server-side: task 49 built the push transaction's apply step but registered no modules, and this
// applier did not exist. So every notification fell back to the default, forever — and task 21's
// own locale test would have stayed GREEN, because it seeds the row directly (T-14b: a fixture
// asserting a join production never makes). The trap closes only when this applier BOTH exists AND
// its module is appended to `SERVER_MODULES` (apps/server/src/deps.ts). Shipping this file alone is
// a half-fix that looks done and folds nothing.
//
// ── LWW WITHOUT AN ORDER CHECK ────────────────────────────────────────────────────────────────
//
// 01 §6: `platform.user_locale_changed` has "No conflict declaration (canonical-order LWW)". The
// applier does NOT compare timestamps to decide a winner, and that absence is deliberate: 04 §4.2
// makes ORDER the runtime's job — "Appliers therefore never see out-of-order input". An op that
// sorts before an already-applied one triggers an entity re-fold, which deletes this user's row and
// replays their full locale history in canonical order. So an unconditional overwrite IS
// last-writer-wins, on both engines, for any arrival order.
//
// Comparing `updatedAt` here instead would be both redundant AND a live T-14f bug: `updated_at` is
// `bigint`, which the production `pg` driver returns as a STRING while better-sqlite3 and PGlite
// return a number. `"9" > "10"` is true. The comparison would be correct in every test lane and
// wrong in production past ten changes — task 46's exact failure. The fix is not to cast; it is to
// not read the column at all, because the engine already answered the question.
import type { ProjectionApplier, ProjectionTableManifest } from '../../projection/manifest.js';
import { PLATFORM_ENTITY } from '../constants.js';
import type { PlatformDatabase } from '../schema.js';

/** `platform.user_locale_changed` payload (07-i18n §1.1): `z.object({ locale }).strict()`. */
export interface UserLocaleChangedPayload {
  readonly locale: string;
}

/** 04 §4.4 table manifest — columns in 10-db DDL order (the oracle's digest order). */
export const userPrefsTable: ProjectionTableManifest = {
  columns: {
    user_id: 'text',
    tenant_id: 'text',
    locale: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['user_id'],
  entityType: PLATFORM_ENTITY.userPref,
  entityIdColumn: 'user_id',
  projectionVersion: 1,
};

/**
 * Fold `platform.user_locale_changed` → the user's `user_prefs` row (LWW, see the header).
 *
 * DELETE-then-INSERT rather than `ON CONFLICT … DO UPDATE`: both engines support upsert, but their
 * conflict-target syntax and semantics are the part of SQL where SQLite and Postgres most plausibly
 * diverge, and 04 §2 restricts appliers to a dialect-neutral subset. Two trivially-portable
 * statements beat one clever one whose portability the T-8 suite would have to establish.
 *
 * Entity-scoped (04 §4.1 rule 2): both statements are keyed by `user_id = op.entityId`, which for
 * this op type IS the acting user (07-i18n §1.1). The applier touches exactly one user's row.
 */
export const userLocaleChangedApplier: ProjectionApplier<PlatformDatabase> = async (db, op) => {
  const payload = op.payload as unknown as UserLocaleChangedPayload;
  await db.deleteFrom('userPrefs').where('userId', '=', op.entityId).execute();
  await db
    .insertInto('userPrefs')
    .values({
      userId: op.entityId,
      tenantId: op.tenantId,
      locale: payload.locale,
      updatedAt: op.timestamp,
    })
    .execute();
};
