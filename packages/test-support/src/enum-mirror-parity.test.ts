// Forced enum-mirror parity gate (task 53; CLAUDE.md §2.8/§2.11) — shrunk to its one remaining
// mirror (task 190). The ui↔schemas arm was retired by task 193 when `@bolusi/ui` gained a
// type-only import of `@bolusi/schemas`, so nothing is left for that arm to guard.
//
// `envelope-generator.SOURCES` re-declares the canonical `OP_SOURCES` (packages/schemas/src/
// envelope.ts). It cannot import-dedupe it: envelope-generator is bundled INTO the Hermes
// JCS-vector runner (scripts/hermes-vectors/runner.ts), whose bundle forbids zod (08 §5.6), and
// `OP_SOURCES` lives in `envelope.ts`, whose top-level `z.*` calls pull zod into any importer.
// A forced mirror is legitimate; an UNGUARDED one is the defect (task 47 — a copy with no gate is a
// second implementation with a green light). This gate reds when the mirror drifts.
//
// This test runs in Node (vitest), NOT inside the Hermes bundle, so it imports BOTH the zod-free
// mirror (`SOURCES`) and the zod-backed canonical set (`OP_SOURCES`) and compares their real
// runtime values — stronger than the old source-text regex, and with no denominator ceremony to
// keep honest: the module loader itself is the anti-vacuity guard (renaming or deleting either
// export fails the import → red, T-14), and the non-empty assert bars an empty-vs-empty pass.
import { OP_SOURCES } from '@bolusi/schemas';
import { describe, expect, it } from 'vitest';

import { SOURCES } from './crypto/envelope-generator.js';

describe('forced enum mirror stays equal to its canonical source (task 53; shrunk task 190)', () => {
  it('envelope-generator.SOURCES ↔ OP_SOURCES — members identical, canonical non-empty', () => {
    expect(
      OP_SOURCES.length,
      'canonical OP_SOURCES is empty — refusing a vacuous pass (T-14)',
    ).toBeGreaterThan(0);
    expect(
      [...SOURCES].sort(),
      'SOURCES (envelope-generator, the zod-free Hermes mirror) diverged from OP_SOURCES. The mirror is boundary-forced (the Hermes JCS bundle forbids importing the canonical); update SOURCES to match — do NOT delete the mirror or this gate.',
    ).toEqual([...OP_SOURCES].sort());
  });
});
