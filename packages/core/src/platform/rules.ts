// The platform op rules (module/op-rules.ts): run by the device before saving and by the server
// before accepting a push.
import { defineRefusals, type OpRule } from '../module/op-rules.js';
import type { PlatformDatabase } from './schema.js';

type Rule = OpRule<PlatformDatabase>;

export const PLATFORM_REFUSALS = defineRefusals('platform', [
  'conflictNotFound',
  'notYourPreference',
] as const);
const { refuse } = PLATFORM_REFUSALS;

/**
 * An acknowledgment needs the conflict, in the op's store (or tenant-wide). It does not need the
 * conflict to still be open: two owners acknowledging the same conflict offline is harmless (the
 * second folds as a no-op, conflicts.ts), so it is not worth a sync problem.
 */
export const conflictAcknowledgedRule: Rule = async (op, { db }) => {
  const storeId = op.storeId;
  const row = await db
    .selectFrom('conflicts')
    .select('id')
    .where('id', '=', op.entityId)
    // A store's conflict, or a tenant-wide one (no store).
    .where((eb) =>
      storeId === null
        ? eb('storeId', 'is', null)
        : eb.or([eb('storeId', '=', storeId), eb('storeId', 'is', null)]),
    )
    .executeTakeFirst();
  if (row === undefined) {
    throw refuse('conflictNotFound', {
      code: 'ENTITY_NOT_FOUND',
      details: { entityId: op.entityId },
    });
  }
};

/** A user sets only their own preferences; the command cannot aim elsewhere, a tampered app can. */
export const userLocaleChangedRule: Rule = (op) =>
  op.entityId === op.userId
    ? Promise.resolve()
    : Promise.reject(
        refuse('notYourPreference', {
          code: 'PERMISSION_DENIED',
          details: { reason: 'restriction_violated', entityId: op.entityId },
        }),
      );
