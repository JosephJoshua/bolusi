// Registry lookup + payload validation (05 §8: UNKNOWN_TYPE vs SCHEMA_INVALID). The two are
// deliberately distinct codes with distinct client behaviour (version-skew prompt vs report-bug),
// so they are separate outcomes here, never merged. Runs LAST (after scope) per 10-db §3.
import type { SignedOperation } from '@bolusi/schemas';

import type { OpRegistry } from '../types.js';

export type SchemaOutcome = null | 'UNKNOWN_TYPE' | 'SCHEMA_INVALID';

export function classifySchema(registry: OpRegistry, op: SignedOperation): SchemaOutcome {
  const resolution = registry.resolve(op.type, op.schemaVersion);
  if (resolution.kind === 'unknown') return 'UNKNOWN_TYPE';
  return resolution.validate(op.payload) ? null : 'SCHEMA_INVALID';
}
