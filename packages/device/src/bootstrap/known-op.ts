import type { OperationRegistry } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

/** Is `op` a type this build registers, at a schemaVersion it can fold? */
export function knowsOp(
  operations: Pick<OperationRegistry, 'schemaVersionFor'>,
  op: Pick<SignedOperation, 'type' | 'schemaVersion'>,
): boolean {
  const known = operations.schemaVersionFor(op.type);
  return known !== undefined && op.schemaVersion <= known;
}
