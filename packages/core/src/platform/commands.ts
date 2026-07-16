// The `platform` module's commands (04 §5): `acknowledgeConflict`, `setLocale`.
import { z } from 'zod';

import { DomainError } from '../errors/domain-error.js';
import type { CommandContext } from '../runtime/ctx.js';
import type { CommandHandlerResult } from '../runtime/execute.js';
import { LOCALE_VALUES, PLATFORM_ENTITY, PLATFORM_OP } from './constants.js';
import { listConflictsQuery } from './queries.js';

// ── acknowledgeConflict ────────────────────────────────────────────────────────────────────────

export const acknowledgeConflictInput = z
  .object({
    conflictId: z.string().min(1),
    /** The owner's decision note (01 §6: `note | null`). Defaulted so the payload is never absent. */
    note: z.string().nullable().default(null),
  })
  .strict();

export type AcknowledgeConflictInput = z.infer<typeof acknowledgeConflictInput>;

/**
 * Acknowledge a SURFACED conflict (03 §7).
 *
 * The precondition is a real read, through the query layer — 04 §5.2 gives a handler no other read
 * seam, and that indirection is what keeps this command honest: it sees exactly the conflicts the
 * caller is allowed to see. The permission arithmetic works out because 02 §12's matrix grants
 * `conflict_view` to every role that has `conflict_acknowledge` (main_owner, store_owner); staff has
 * neither, and is denied at execute step 2 before this handler ever runs.
 *
 * WHY THE APPLIER'S TOTALITY IS NOT ENOUGH TO SKIP THIS. The applier no-ops an ack against a
 * non-`surfaced` conflict, so a bad ack would corrupt nothing. But 03 §7 requires the COMMAND to
 * refuse: emitting an op that is guaranteed to fold into nothing would append a permanent, signed,
 * synced lie to an append-only log — every device would replay an acknowledgment that never
 * acknowledged anything, and the user would be told their click worked.
 *
 * @throws {DomainError} `ENTITY_NOT_FOUND` — no such conflict in the caller's scope.
 * @throws {DomainError} `INVALID_TRANSITION` — the conflict is `auto_resolved` or already
 *   `acknowledged` (03 §7's "Invalid (command-time)" row; `details` per 03 §12).
 */
export async function acknowledgeConflictHandler(
  input: AcknowledgeConflictInput,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ conflictId: string }>> {
  const page = await ctx.query(listConflictsQuery, {
    conflictId: input.conflictId,
    sort: 'detectedAt.desc' as const,
    limit: 1,
  });
  const conflict = page.rows[0];

  if (conflict === undefined) {
    throw new DomainError(
      'ENTITY_NOT_FOUND',
      { entityType: PLATFORM_ENTITY.conflict, entityId: input.conflictId },
      `no conflict ${input.conflictId} is visible in this scope`,
    );
  }

  if (conflict.status !== 'surfaced') {
    // 03 §12's details shape, exactly: `{machine, from, event, entityId?}`.
    throw new DomainError(
      'INVALID_TRANSITION',
      {
        machine: 'conflict',
        from: conflict.status,
        event: PLATFORM_OP.conflictAcknowledged,
        entityId: input.conflictId,
      },
      `conflict ${input.conflictId} is ${conflict.status}; only a surfaced conflict can be acknowledged (03 §7)`,
    );
  }

  return {
    ops: [
      ctx.op({
        type: PLATFORM_OP.conflictAcknowledged,
        entityType: PLATFORM_ENTITY.conflict,
        // The conflict IS the entity (01 §6) — same entityType/entityId as its detection op, which
        // is what lets the §4.2 re-fold replay the pair together.
        entityId: input.conflictId,
        payload: { note: input.note },
      }),
    ],
    result: { conflictId: input.conflictId },
  };
}

// ── setLocale ──────────────────────────────────────────────────────────────────────────────────

export const setLocaleInput = z.object({ locale: z.enum(LOCALE_VALUES) }).strict();

export type SetLocaleInput = z.infer<typeof setLocaleInput>;

/**
 * Set the ACTING user's locale (07-i18n §1.1). Any active user, for themselves.
 *
 * SELF-ONLY BY CONSTRUCTION, not by a check. The input carries no target: `entityId` is
 * `ctx.userId`, which the runtime minted and froze, so there is no value a caller could supply to
 * aim this at someone else. A `targetUserId` input plus an `if (target !== ctx.userId) throw` would
 * be the same rule expressed as a thing to remember — and `auth.pin_changed` needing a server-side
 * `userId == entityId` scope rule (05 §9 item 5) is what that costs.
 *
 * The op is TENANT-scoped (`storeId: null`, 01 §6) — resolved by `ctx.op()` from the type's
 * `scope: 'tenant'` declaration, not stated here. The preference follows the user to every device.
 */
export function setLocaleHandler(
  input: SetLocaleInput,
  ctx: CommandContext,
): CommandHandlerResult<{ locale: string }> {
  return {
    ops: [
      ctx.op({
        type: PLATFORM_OP.userLocaleChanged,
        entityType: PLATFORM_ENTITY.userPref,
        entityId: ctx.userId,
        payload: { locale: input.locale },
      }),
    ],
    result: { locale: input.locale },
  };
}
