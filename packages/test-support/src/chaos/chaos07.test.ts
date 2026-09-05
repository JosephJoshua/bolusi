// `detectedEditAfterArchive` — CHAOS-07's leg-2 non-vacuity witness (task 198). It answers ONE question
// off device B's pulled op log: did the SIGNIFICANT edit-after-archive `platform.conflict_detected` op for
// note-2 actually arrive? That boolean gates the "(iii) never surfaced ⇒ INCONCLUSIVE" branch of
// `evaluateChaos07`, so it must not be forgeable by leg 1's own conflict traffic.
//
// Leg 1 (concurrent same-note edits on note-1) ALSO makes the server mint `platform.conflict_detected`
// ops — MINOR `{note.body}` ones — which B pull-drains into the SAME wire. So a witness that merely asks
// "any conflict_detected op present?" reads `true` from leg 1 alone, even when leg 2's op never arrived.
// That defeats the guard: a leg-2 delivery regression would then skip INCONCLUSIVE and fall through to the
// surfacing RED, falsely blaming the client classification fold (03 §7) for a transport failure. The helper
// is scoped to note-2 AND `significant` to make the witness answer leg 2 and leg 2 only.
//
// The full device→server round trip proves leg 2 end to end in packages/harness/scenarios/
// device-runner-chaos-07.test.ts (a real loopback socket, detection ON). That integration cannot isolate
// THIS regression: in the happy path both legs fire, so the unscoped and scoped forms agree. This pure unit
// is where the scoping is falsified — the host proof is the backstop, not the witness for the scope.
//
// ── FALSIFICATION (§2.11) ──────────────────────────────────────────────────────────────────────────
// Revert the helper body to the unscoped `wire.some((o) => o.type === PLATFORM_OP.conflictDetected)` and
// re-run: the two scope cases below go red — "leg 1's MINOR note-1 ops alone" and "a MINOR conflict on
// note-2" both flip to `true`, so a leg-2-only regression would read as a witnessed leg 2. Restoring the
// `entityId === noteId && severity === 'significant'` scope returns them to green, so the witness cannot be
// forged by leg 1's traffic nor by a minor conflict on the target note.
import { PLATFORM_OP } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';
import { describe, expect, test } from 'vitest';

import { detectedEditAfterArchive } from './chaos07.js';

const NOTE2 = 'note-2-under-test';
const NOTE1 = 'note-1-concurrent';

/** A synthetic wire op carrying only the fields the witness reads — the op's TOP-LEVEL entityId is a NEW
 *  conflict id (01 §6), so the conflicted note id + its severity live on the payload. The cast mirrors the
 *  rig's own payload cast idiom (chaos07.ts): the helper never touches the signature/envelope fields. */
function conflictOp(entityId: string, severity: 'minor' | 'significant'): SignedOperation {
  return {
    type: PLATFORM_OP.conflictDetected,
    payload: { entityId, severity },
  } as unknown as SignedOperation;
}

/** A non-conflict op the witness must ignore regardless of its payload. */
function ackOp(entityId: string): SignedOperation {
  return {
    type: PLATFORM_OP.conflictAcknowledged,
    payload: { entityId, severity: 'significant' },
  } as unknown as SignedOperation;
}

describe('detectedEditAfterArchive — CHAOS-07 leg-2 witness scoping (task 198)', () => {
  test('true when a SIGNIFICANT conflict_detected op for note-2 is present', () => {
    const wire = [conflictOp(NOTE1, 'minor'), conflictOp(NOTE2, 'significant')];
    expect(detectedEditAfterArchive(wire, NOTE2)).toBe(true);
  });

  test("false from leg 1's MINOR note-1 conflict ops alone — the regression the scope guards", () => {
    // Leg 2's op never arrived; only leg 1's minor note-1 conflicts are on the wire. The unscoped form
    // reads these as a witnessed leg 2 (the defeated guard); the scoped form must not.
    const wire = [conflictOp(NOTE1, 'minor'), conflictOp(NOTE1, 'minor')];
    expect(detectedEditAfterArchive(wire, NOTE2)).toBe(false);
  });

  test('false for a MINOR conflict on note-2 — severity scope, not just entity scope', () => {
    const wire = [conflictOp(NOTE2, 'minor')];
    expect(detectedEditAfterArchive(wire, NOTE2)).toBe(false);
  });

  test('false for a SIGNIFICANT conflict on a DIFFERENT note — entity scope, not just severity', () => {
    const wire = [conflictOp(NOTE1, 'significant')];
    expect(detectedEditAfterArchive(wire, NOTE2)).toBe(false);
  });

  test('false when no conflict_detected op is present — other op types are ignored', () => {
    const wire = [ackOp(NOTE2)];
    expect(detectedEditAfterArchive(wire, NOTE2)).toBe(false);
  });
});
