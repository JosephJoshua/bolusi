// An op-log row for a fixture op: the op and its canonical signed text, as `insertOpLogRow` takes.
//
// Production computes the text with `signedCoreJcsOf`, which also checks the op is a valid signed core.
// Many fixtures are deliberately not (placeholder ids, unsigned ops), so this canonicalizes without
// that check. The text is still the op's real canonical text, so a reader rebuilds the same op.
import { canonicalizeJcs, type JsonValue, type OpRow } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { toSignedCore } from './builder.js';

export function opRowOf(op: SignedOperation): OpRow {
  return { op, signedCoreJcs: canonicalizeJcs(toSignedCore(op) as unknown as JsonValue) };
}
