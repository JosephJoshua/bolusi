// FR-1138 — ops sync INDEPENDENTLY of media. The client half, asserted rather than asserted-about.
//
// This file exists because `drain.ts` and `download.ts` each claimed "asserted in the suite" and no
// such assertion existed (caught in review-18). Task 18's acceptance is explicit: "no import path
// from the media engine into op-sync internals (assert via lint boundary or unit test)". A comment
// claiming a guard exists is worse than silence — it is the shape that stops the next reader
// checking (§2.11).
//
// WHAT FR-1138 ACTUALLY FORBIDS, and why the direction matters. 06 §4: "the op sync loop never
// waits on, inspects, or is blocked by MediaItem state, and vice versa". The media engine importing
// op-sync internals would let a media stall block an op push — a note becomes unusable because a
// photo has not uploaded, on a 3G uplink, which is precisely the failure FR-1138 names.
//
// The REVERSE edge is legitimate and must NOT be flagged: `sync/state.ts`'s `pendingMediaCount`
// reads `media_items`, because 06 §4 says that count is "recomputed by the sync loop (api/01-sync
// §6)". So this is a one-way assertion, and a naive "media and sync never touch" test would be
// wrong in a way that looks stricter.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const MEDIA_SRC = new URL('../../src/media/', import.meta.url).pathname;

function mediaSourceFiles(): readonly string[] {
  return readdirSync(MEDIA_SRC).filter((f) => f.endsWith('.ts'));
}

function importsOf(file: string): readonly string[] {
  const text = readFileSync(join(MEDIA_SRC, file), 'utf8');
  // Every static import/export specifier. Type-only imports count: an `import type` from sync
  // internals would still be a coupling of contracts, and it is the shape that precedes a value
  // import.
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) specifiers.push(match[1] as string);
  // Dynamic imports too — `await import('../sync/loop.js')` is the obvious way around a static check.
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamic.exec(text)) !== null) specifiers.push(match[1] as string);
  return specifiers;
}

describe('FR-1138: the media engine has no import path into op-sync internals', () => {
  it('reads a non-empty set of media source files', () => {
    // Denominator (T-14). Without this, a wrong path or a renamed directory makes every assertion
    // below loop over ZERO files and report green — this repo's signature failure, shipped 8x.
    const files = mediaSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files).toContain('drain.ts');
    expect(files).toContain('download.ts');
    expect(files).toContain('repository.ts');
  });

  it('no media source file imports from ../sync/ — the coupling FR-1138 forbids', () => {
    const violations: string[] = [];
    let filesChecked = 0;
    let importsChecked = 0;

    for (const file of mediaSourceFiles()) {
      filesChecked += 1;
      for (const specifier of importsOf(file)) {
        importsChecked += 1;
        if (/(^|\/)\.\.\/sync\//.test(specifier) || /@bolusi\/core\/.*sync/.test(specifier)) {
          violations.push(`${file} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
    // Denominators: the loop really walked files AND really parsed imports out of them. A regex
    // that silently matched nothing would otherwise satisfy the assertion above.
    expect(filesChecked).toBeGreaterThanOrEqual(7);
    expect(importsChecked).toBeGreaterThanOrEqual(10);
  });

  it('the parser actually finds imports — positive control for the check above', () => {
    // T-17: the fence ("no sync imports") is satisfied trivially if the parser finds nothing at all.
    // This proves it finds the imports that ARE there, so the absence above is a real absence.
    const drainImports = importsOf('drain.ts');
    expect(drainImports).toContain('./repository.js');
    expect(drainImports).toContain('./backoff.js');
    expect(drainImports.length).toBeGreaterThanOrEqual(4);

    // And it catches the forbidden shape when one exists: same regex, hostile input.
    const forbidden = ['../sync/loop.js', '../sync/state.js', '@bolusi/core/dist/sync/loop.js'];
    for (const specifier of forbidden) {
      const hits = /(^|\/)\.\.\/sync\//.test(specifier) || /@bolusi\/core\/.*sync/.test(specifier);
      expect(hits, specifier).toBe(true);
    }
  });

  it('the drain loop selects on media_items alone — no join to operations or sync_state', () => {
    // The behavioural half of the same invariant: even without an import, a SQL join to the op
    // tables would couple the two loops. `repository.ts` is the only place media rows are read.
    //
    // COMMENTS ARE STRIPPED FIRST, and the first version of this test did not strip them — it
    // substring-matched the whole file and went red on the prose "no join to `operations`" in
    // repository.ts's own header. That is T-16 exactly (a mention is not a producer), committed
    // inside the fix for a comment-that-lied bug. A test that cannot tell code from prose about
    // code is a mention-counter, and it fails in both directions: this one cried wolf, and its
    // mirror image would go green on a real join sitting under a comment that said "no join".
    const raw = readFileSync(join(MEDIA_SRC, 'repository.ts'), 'utf8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ') // block + JSDoc
      .replace(/(^|[^:])\/\/.*$/gm, '$1 '); // line comments (not the // in a URL)

    // Positive controls (T-17): the stripper left the SQL intact, and it really did remove prose.
    // Without these, a stripper that ate the whole file would satisfy every `not.toMatch` below.
    expect(code).toContain('media_items');
    expect(code).toContain('UPDATE media_items');
    expect(raw).toContain('no join to `operations`'); // the prose exists...
    expect(code).not.toContain('no join to `operations`'); // ...and was stripped.

    for (const table of ['operations', 'sync_state', 'outbox', 'quarantined_ops']) {
      // Word-boundary: `attached_to_operation_id` is a media_items column (06 §4) and must not be
      // mistaken for the `operations` table.
      expect(code, `repository.ts SQL must not touch ${table}`).not.toMatch(
        new RegExp(`\\b${table}\\b`),
      );
    }
  });

  it('06 §6: no sync-loop code path imports the render-time downloader — media is never prefetched', () => {
    // The OTHER direction, and a different claim: 06 §6 says remote media is fetched "on demand at
    // render time — never prefetched in the sync loop". `download.ts` asserted this in a comment;
    // this is the assertion. A sync loop that prefetched media would pull every photo of every
    // pulled op over a 3G uplink before the user asked to see one.
    const syncDir = new URL('../../src/sync/', import.meta.url).pathname;
    const syncFiles = readdirSync(syncDir).filter((f) => f.endsWith('.ts'));
    expect(syncFiles.length).toBeGreaterThanOrEqual(4); // denominator (T-14)

    const violations: string[] = [];
    for (const file of syncFiles) {
      const text = readFileSync(join(syncDir, file), 'utf8');
      if (/from\s*['"][^'"]*media\/(download|drain)/.test(text)) violations.push(file);
      if (/\bfetchAndVerifyMedia\b|\bMediaDrainLoop\b/.test(text)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('the reverse edge is allowed: sync may read media_items (06 §4s pendingMediaCount)', () => {
    // Stated as a test so nobody "fixes" the one-way assertion into a two-way one. 06 §4 puts
    // pendingMediaCount in the sync loop by design; task 15 shipped it there.
    const syncState = readFileSync(
      new URL('../../src/sync/state.ts', import.meta.url).pathname,
      'utf8',
    );
    expect(syncState).toContain('media_items');
    expect(syncState).toContain('pendingMediaCount');
  });
});
