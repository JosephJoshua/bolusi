// The tiny PLATFORM/DOMAIN-free wire helpers the convergence rig and its three CHAOS device runners all
// share (task 200). Before this module `deviceSeed`/`notesOnly`/`dedupeById` were re-declared byte-for-byte
// in convergence.ts + chaos03.ts (and `deviceSeed` again in chaos06.ts + chaos07.ts) — the same three
// copies §2.8 warns about. They live here ONCE now.
//
// Bundle-safe by construction: the only import is a TYPE (`SignedOperation`, erased at compile), so this
// reaches no `node:` builtin and does not widen the Hermes on-device bundle — `chaos-bundle-safe.test.ts`
// still guards the no-`node:` claim.
import type { SignedOperation } from '@bolusi/schemas';

/** Only notes ops fold into the projection; per-device genesis enroll ops are not folded. */
export function notesOnly(ops: readonly SignedOperation[]): SignedOperation[] {
  return ops.filter((op) => op.type.startsWith('notes.'));
}

/** A per-device authoring PRNG seed, distinct per (run seed, device index). */
export function deviceSeed(seed: number, index: number): number {
  return (Math.imul(seed + 1, 0x9e37_79b1) ^ Math.imul(index + 1, 0x85eb_ca77)) >>> 0;
}

/** Union ops deduped by id, keep-first (after a cross-feed every device holds all of them). */
export function dedupeById(ops: readonly SignedOperation[]): SignedOperation[] {
  const byId = new Map<string, SignedOperation>();
  for (const op of ops) if (!byId.has(op.id)) byId.set(op.id, op);
  return [...byId.values()];
}
