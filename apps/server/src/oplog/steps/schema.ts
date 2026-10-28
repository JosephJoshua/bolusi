// Registry lookup + payload validation (05 §8: UNKNOWN_TYPE vs SCHEMA_INVALID). The two are
// deliberately distinct codes with distinct client behaviour (version-skew prompt vs report-bug),
// so they are separate outcomes here, never merged. Runs LAST (after scope) per 10-db §3.
import { containsNulCharacter, type SignedOperation } from '@bolusi/schemas';

import type { OpRegistry } from '../types.js';

export type SchemaOutcome = null | {
  readonly code: 'UNKNOWN_TYPE' | 'SCHEMA_INVALID';
  readonly reason: string;
};

export function classifySchema(registry: OpRegistry, op: SignedOperation): SchemaOutcome {
  const resolution = registry.resolve(op.type, op.schemaVersion);
  if (resolution.kind === 'unknown') {
    return { code: 'UNKNOWN_TYPE', reason: `type ${op.type} is not in the server registry` };
  }
  // The record kind is fixed by the type, not chosen by the author: an op that names another kind
  // would fold into (or conflict-match against) records its type never writes.
  const entityType = registry.entityTypeOf(op.type);
  if (op.entityType !== entityType) {
    return {
      code: 'SCHEMA_INVALID',
      reason: `${op.type} writes ${String(entityType)}, not ${op.entityType}`,
    };
  }
  if (resolution.kind === 'retired') {
    return {
      code: 'SCHEMA_INVALID',
      reason: `${op.type} v${op.schemaVersion} is no longer accepted; the oldest accepted is v${resolution.minPushVersion}`,
    };
  }
  if (!resolution.validate(op.payload)) {
    return { code: 'SCHEMA_INVALID', reason: `payload fails the registry schema for ${op.type}` };
  }
  // Postgres cannot store U+0000 in jsonb or text: an op holding one would throw at INSERT and fail
  // the whole batch, re-sent forever. Refused here, per op, like any other invalid payload.
  if (containsNulCharacter(op)) {
    return { code: 'SCHEMA_INVALID', reason: 'the operation contains a NUL character' };
  }
  return null;
}
