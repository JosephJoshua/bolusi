// Server → client op rejection codes (05-operation-log §8) — all eleven, including
// the batch-halt code CHAIN_HALTED. CHAOS-05's rejection matrix consumes this enum;
// additions/removals are spec changes to 05 §8 first.
import { z } from 'zod';

export const REJECTION_CODES = [
  'BAD_SIGNATURE',
  'CHAIN_BROKEN',
  'CHAIN_GAP',
  'CHAIN_HALTED',
  'CLOCK_AHEAD',
  'DEVICE_REVOKED',
  'PERMISSION_DENIED',
  'RULE_VIOLATED',
  'SCHEMA_INVALID',
  'SCOPE_VIOLATION',
  'UNKNOWN_TYPE',
] as const;

export const zRejectionCode = z.enum(REJECTION_CODES);
export type RejectionCode = z.infer<typeof zRejectionCode>;
