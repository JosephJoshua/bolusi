// Registry lookup + payload validation (05 §8: UNKNOWN_TYPE vs SCHEMA_INVALID). The two are
// deliberately distinct codes with distinct client behaviour (version-skew prompt vs report-bug),
// so they are separate outcomes here, never merged. Runs LAST (after scope) per 10-db §3.
import type { SignedOperation } from '@bolusi/schemas';

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
  if (!resolution.validate(op.payload)) {
    return { code: 'SCHEMA_INVALID', reason: `payload fails the registry schema for ${op.type}` };
  }
  return null;
}
