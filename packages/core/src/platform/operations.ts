// The `platform` module's operation registry (04 §3; 01 §6 is the authoritative type list).
//
// ── NONE OF THE THREE DECLARES A `conflict` KEY, AND THAT IS THE POINT ────────────────────────
//
// 01 §8.1: "Ops without a `conflict` declaration never generate Conflict records." All three
// platform types omit it, so the detection engine never considers them — which is what stops the
// obvious recursion: a `platform.conflict_detected` op is itself an accepted op on an entity, and a
// detection rule that looked at it would manufacture conflicts about conflicts, forever, each one
// emitting another detection op. The absence below is load-bearing, not an oversight, and
// `conflicts-never-cascade` in the module suite is what keeps it that way.
//
// `platform.user_locale_changed` omits it for a different reason 01 §6 states outright: "No
// conflict declaration (canonical-order LWW)" — two devices setting a locale is not a collision a
// human should ever hear about; the later one simply wins.
import { z } from 'zod';

import type { OperationDeclaration } from '../module/define-module.js';
import { LOCALE_VALUES, PLATFORM_OP } from './constants.js';
import { conflictAcknowledgedApplier, conflictDetectedApplier } from './projections/conflicts.js';
import { userLocaleChangedApplier } from './projections/user-prefs.js';
import type { PlatformDatabase } from './schema.js';

/** `platform.conflict_detected` payload (01 §6). `.strict()` per 04 §3. */
export const conflictDetectedPayload = z
  .object({
    entityType: z.string().min(1),
    entityId: z.string().min(1),
    conflictKey: z.string().min(1),
    // Static per the declaring op type (01 §8.3) — the server copies the declaration's value in.
    severity: z.enum(['minor', 'significant']),
    opAId: z.string().min(1),
    opBId: z.string().min(1),
  })
  .strict();

/** `platform.conflict_acknowledged` payload (01 §6): `note | null`. */
export const conflictAcknowledgedPayload = z
  .object({
    // Present-and-null, never absent (05 §3's absent-vs-null rule: the JCS preimage has no
    // optional keys). `.nullable()`, not `.optional()`.
    note: z.string().nullable(),
  })
  .strict();

/** `platform.user_locale_changed` payload (07-i18n §1.1: `z.object({ locale }).strict()`). */
export const userLocaleChangedPayload = z.object({ locale: z.enum(LOCALE_VALUES) }).strict();

/** The three platform op declarations (04 §3), keyed by op type. */
export const platformOperations: Readonly<Record<string, OperationDeclaration<PlatformDatabase>>> =
  {
    [PLATFORM_OP.conflictDetected]: {
      schemaVersion: 1,
      payload: conflictDetectedPayload,
      // 01 §5.4 / I-7: "Conflict records are never deleted; `acknowledged` and `auto_resolved` are
      // terminal; an owner decision is expressed only as a new operation." There is no undo.
      reversal:
        'NOT reversible, by design (01 §5.4, I-7). A detection op records that two ops collided — a fact about history, which cannot become untrue. The owner responds with platform.conflict_acknowledged and, if the data needs correcting, an ordinary new op (the system never rewrites anything — FR-1131, 05 §1).',
      apply: conflictDetectedApplier,
      // Store-scoped: the envelope carries the CONFLICTED entity's store, which routes the conflict
      // to the right devices via pull scope (01 §5.4). Left as the 'store' default rather than
      // declared, because the server builds this op directly (appendSystemOp) — it never travels
      // through ctx.op(), so a scope declaration here would be inert and therefore a decoy.
    },

    [PLATFORM_OP.conflictAcknowledged]: {
      schemaVersion: 1,
      payload: conflictAcknowledgedPayload,
      reversal:
        'NOT reversible (01 §5.4, I-7: `acknowledged` is terminal). An acknowledgment is a decision record — that the owner saw this conflict and accepted the recorded outcome. Un-seeing it is not a thing; a changed mind is a new ordinary op correcting the data.',
      apply: conflictAcknowledgedApplier,
    },

    [PLATFORM_OP.userLocaleChanged]: {
      schemaVersion: 1,
      payload: userLocaleChangedPayload,
      reversal:
        'Reversed by a subsequent platform.user_locale_changed carrying the previous locale (07-i18n §1.1).',
      apply: userLocaleChangedApplier,
      // TENANT-scoped (01 §6): "the preference follows the user to every device". Without this the
      // runtime would stamp the emitting device's store and the preference would reach only that
      // store's devices — the one op type in v0 that is not store-scoped.
      scope: 'tenant',
    },
  };
