// What a customer's status page receives for a servisan (GET /v1/public/status/:code). Defined once
// for the server, which builds it from its records, and the web page, which shows it. Only what the
// customer already knows or is owed: no names of staff, no photos, no unlock code, no notes.
import { z } from 'zod';

export const REPAIR_STATUS_STEPS = [
  'received',
  'in_repair',
  'waiting_for_parts',
  'repaired',
  'cancelled',
  'returned',
] as const;
export const zRepairStatusStep = z.enum(REPAIR_STATUS_STEPS);
export type RepairStatusStep = z.infer<typeof zRepairStatusStep>;

const zMs = z.number().int().nonnegative();
const zIdr = z.number().int();

export const zPublicRepairStatus = z
  .object({
    store: z
      .object({
        name: z.string(),
        address: z.string(),
        phone: z.string(),
      })
      .strict(),
    ticketNumber: z.string(),
    /** Brand and model, e.g. "Samsung Galaxy A15". */
    device: z.string(),
    /** Where the servisan is now. */
    status: zRepairStatusStep,
    /** Each change of step, oldest first; a reopened repair shows its steps again. */
    steps: z.array(z.object({ step: zRepairStatusStep, at: zMs }).strict()),
    estimatedReadyAt: zMs.nullable(),
    money: z
      .object({
        /** The bill: the agreed price, or the cancellation fee of a cancelled servisan. */
        total: zIdr,
        /** Paid so far (DP and later payments, less refunds). */
        paid: zIdr,
      })
      .strict(),
    /** Price changes the store is waiting for the customer to agree to. */
    pendingPrices: z.array(z.object({ description: z.string(), amount: zIdr }).strict()),
    /** The repair types and their warranty days, as the servisan recorded them. */
    repairTypes: z.array(
      z
        .object({ item: z.string(), label: z.string().nullable(), warrantyDays: z.number().int() })
        .strict(),
    ),
    /** When the phone went home (the warranty counts from here); null while it is in the store. */
    returnedAt: zMs.nullable(),
    /** When the store last changed anything on it, as far as the server has heard. */
    updatedAt: zMs,
  })
  .strict();
export type PublicRepairStatus = z.infer<typeof zPublicRepairStatus>;

/** A status page stays up this long after the warranty (or the pickup, without one) ends. */
export const STATUS_PAGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
