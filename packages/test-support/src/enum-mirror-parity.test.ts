// Forced enum-mirror parity gate (task 53; CLAUDE.md §2.8/§2.11).
//
// Two closed sets from the enum registry (03-state-machines §2) are re-declared away from their
// canonical home because an import boundary FORBIDS deriving them from the owner:
//
//   - `@bolusi/ui`'s `OperationSyncStatus` mirrors `SYNC_STATUSES` — ui may import @bolusi/i18n +
//     React Native + expo only (08 §3.3), never @bolusi/schemas.
//   - this package's `envelope-generator.SOURCES` mirrors `OP_SOURCES` — the generator is bundled
//     into the Hermes JCS-vector runner (scripts/hermes-vectors/runner.ts), whose bundle forbids
//     zod (08 §5.6); `OP_SOURCES` lives in `envelope.ts`, whose top-level `z.*` calls pull zod into
//     any importer, so it cannot be import-deduped.
//
// A forced mirror is legitimate; an UNGUARDED forced mirror is the defect (task 47's lesson: a copy
// with no gate is a second implementation with a green light). This gate compares each mirror,
// read from its REAL source (never a fourth hand-typed copy), against the REAL canonical set
// imported from @bolusi/schemas — and reddens when they diverge. It asserts its own denominator
// (T-14): the number of mirrors guarded, that each canonical set is non-empty, and that the
// extractor actually FOUND a set (it throws rather than pass vacuously on a rename/miss).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { OP_SOURCES, SYNC_STATUSES } from '@bolusi/schemas';
import { describe, expect, it } from 'vitest';

/** Comments legitimately name the const the gate hunts for; strip them so they never false-match. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Extract the members of a `const <name> = ['a', 'b', …] as const` declaration from source text.
 * Throws on a miss or an empty set — a parity gate that silently compares nothing is worse than no
 * gate (CLAUDE.md §2.11 / T-14). Reading the REAL source (not a re-typed literal) is what keeps the
 * gate honest: it tracks whatever the mirror actually declares.
 */
function extractConstStringArray(source: string, name: string): string[] {
  const stripped = stripComments(source);
  const body = stripped.match(
    new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]\\s*as\\s+const`),
  )?.[1];
  if (body === undefined) {
    throw new Error(
      `parity gate could not locate \`const ${name} = [...] as const\` — the mirror was renamed or moved; refusing to pass vacuously (T-14).`,
    );
  }
  const members = [...body.matchAll(/['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((member): member is string => member !== undefined);
  if (members.length === 0) {
    throw new Error(
      `parity gate extracted zero members from \`${name}\` — refusing to compare an empty set (T-14).`,
    );
  }
  return members;
}

interface MirrorSpec {
  readonly name: string;
  /** The canonical closed set, imported live from its owner (@bolusi/schemas). */
  readonly canonical: readonly string[];
  /** The mirror's source file. */
  readonly file: URL;
  /** The `const <name> = [...] as const` the mirror declares. */
  readonly constName: string;
  /** Why the mirror cannot be import-deduped — surfaced in the failure message. */
  readonly boundary: string;
}

const MIRRORS: readonly MirrorSpec[] = [
  {
    name: '@bolusi/ui SyncStatusChip.OperationSyncStatus ↔ SYNC_STATUSES',
    canonical: SYNC_STATUSES,
    file: new URL('../../ui/src/components/SyncStatusChip.tsx', import.meta.url),
    constName: 'OPERATION_SYNC_STATUSES',
    boundary: '@bolusi/ui may not import @bolusi/schemas (08 §3.3)',
  },
  {
    name: 'envelope-generator.SOURCES ↔ OP_SOURCES',
    canonical: OP_SOURCES,
    file: new URL('./crypto/envelope-generator.ts', import.meta.url),
    constName: 'SOURCES',
    boundary: 'the Hermes JCS-vector bundle forbids zod (08 §5.6)',
  },
];

describe('forced enum mirrors stay equal to their canonical source (task 53)', () => {
  it('guards every known forced enum mirror — denominator (T-14)', () => {
    // A new forced mirror MUST be added to MIRRORS with its own case; this pins the count so one
    // cannot land unguarded. Update this number (and add the spec) when a mirror is added/removed.
    expect(MIRRORS).toHaveLength(2);
  });

  it.each(MIRRORS)('$name — members identical, both sets non-empty', (spec) => {
    const canonical = [...spec.canonical].sort();
    const mirror = extractConstStringArray(
      readFileSync(fileURLToPath(spec.file), 'utf8'),
      spec.constName,
    ).sort();

    // Denominator (T-14): never compare an empty canonical set green.
    expect(canonical.length, `canonical set for ${spec.name} is empty`).toBeGreaterThan(0);
    expect(
      mirror,
      `${spec.name}: mirror diverged from its canonical set. The mirror is boundary-forced (${spec.boundary}); update the mirror to match the canonical, do NOT delete the mirror or the gate.`,
    ).toEqual(canonical);
  });
});
