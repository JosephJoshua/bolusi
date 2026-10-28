// FR-1138 at the APP layer — the media drain is wired INDEPENDENTLY of the sync loop (task 132 item
// 4). The core half of this invariant is asserted in `packages/core/test/media/sync-independence.test.ts`
// (no import path from the media engine into op-sync internals). That guard cannot reach here: the
// app layer re-wires both loops from platform ports, and the coupling it must forbid is a DIFFERENT
// shape — an app-layer media file reaching into the sync loop's SCHEDULING, not core's sync module.
//
// WHAT IS LEGITIMATE, AND WHY THE GUARD IS AN ALLOWLIST RATHER THAN A FENCE. `media/triggers.ts`
// (06 §5.2) is defined to "mirror the sync-loop triggers (api/01-sync §5), evaluated INDEPENDENTLY".
// The mirror is BY CONSTRUCTION: it imports the sync triggers' two interval constants and two port
// TYPES from `bootstrap/triggers.ts` and restates nothing (§2.8), so a change to one cadence cannot
// silently desynchronise the other. It shares those four symbols and NONE of the sync loop's
// scheduling state. So a blanket "media never imports bootstrap/triggers" would red on the legitimate
// mirror; the real erosion FR-1138 forbids is a media file importing a SCHEDULING symbol —
// `createSyncTriggers`, the `SyncTriggers`/`SyncTriggerDeps` wiring, `SyncClient`/`SyncLoop`, or the
// sync-client module — which would let a stalled 3G media upload hold up an op push (06 §1/§4).
//
// Modelled on the core test's shape: DENOMINATORS (T-14 — the loops really walked files and parsed
// real imports, so an empty match cannot report green, this repo's 8x signature failure) and a
// POSITIVE CONTROL (T-17 — the parser finds the imports that ARE there and flags the forbidden shape
// when one exists, so the absence asserted below is a real absence). Comments are stripped before
// parsing (T-16 — a mention is not a producer): `client.ts` and `native.ts` name `SyncLoop`/
// `SyncClient`/`bootstrap/triggers` in PROSE, and a substring check would cry wolf on them.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const MEDIA_SRC = new URL('.', import.meta.url).pathname;

/** The sync-trigger module the media layer legitimately mirrors. */
const SYNC_TRIGGER_MODULE = /(^|\/)\.\.\/bootstrap\/triggers(\.js)?$/;

/**
 * The ONLY names a media source file may import from `bootstrap/triggers.ts` (06 §5.2): the two
 * interval constants and the two platform-port types the media triggers mirror. Anything else pulled
 * from the sync-trigger module is a coupling of the two loops. Widening this set is a deliberate,
 * reviewable diff — which is the whole point of the guard.
 */
const ALLOWED_FROM_SYNC_TRIGGERS: ReadonlySet<string> = new Set([
  'APPEND_DEBOUNCE_MS',
  'FOREGROUND_INTERVAL_MS',
  'AppStatePort',
  'NetInfoPort',
]);

/** Sync-loop SCHEDULING symbols no media file may import, from any source (defence in depth). */
const FORBIDDEN_SYNC_NAMES =
  /^(createSyncTriggers|SyncTriggers|SyncTriggerDeps|SyncTriggerReason|SyncSchedulerPort|SyncLoop|SyncClient)$/;

/** Sync-loop MODULES no media file may import (the sync-client wiring, or any `../sync/` internal). */
const FORBIDDEN_SYNC_SOURCE = /(^|\/)sync(-|\/)/;

/** Media SOURCE files only — colocated `*.test.ts(x)` are excluded (a test may import anything). */
function mediaSourceFiles(): readonly string[] {
  return readdirSync(MEDIA_SRC).filter(
    (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/\.d\.ts$/.test(f),
  );
}

/** Strip block + line comments so a `SyncLoop` mentioned in PROSE is never counted as an import. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block + JSDoc
    .replace(/(^|[^:])\/\/.*$/gm, '$1 '); // line comments (not the // in a URL)
}

interface ParsedImport {
  readonly source: string;
  /** The ORIGINAL (exported) names this statement pulls; `*` for a namespace import. */
  readonly names: readonly string[];
}

/** Every static import/export-from statement in a file, with its imported names. */
function importsOf(file: string): readonly ParsedImport[] {
  const code = stripComments(readFileSync(join(MEDIA_SRC, file), 'utf8'));
  const out: ParsedImport[] = [];
  // The clause between `import`/`export` and `from` may span lines (a `{ … }` block). Non-greedy up
  // to the first `from '…'`. `export … from` re-exports count — a re-exported sync symbol couples too.
  const pattern = /(?:^|\n)\s*(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    out.push({ source: match[2] as string, names: namesFromClause(match[1] as string) });
  }
  return out;
}

/** Pull the original imported names out of an import clause (handles `type`, `as`, `{}`, `* as`). */
function namesFromClause(rawClause: string): string[] {
  const clause = rawClause.replace(/^\s*type\s+/, '').trim();
  const names: string[] = [];
  if (/\*\s+as\s+\w+/.test(clause)) names.push('*'); // namespace import — pulls everything

  const brace = clause.match(/\{([\s\S]*)\}/);
  if (brace) {
    for (const part of (brace[1] as string).split(',')) {
      const member = part.trim().replace(/^type\s+/, '');
      if (member === '') continue;
      const imported = (member.split(/\s+as\s+/)[0] as string).trim(); // `Foo as Bar` -> `Foo`
      if (imported !== '') names.push(imported);
    }
    const beforeBrace = clause.slice(0, brace.index).replace(/,\s*$/, '').trim();
    if (beforeBrace !== '' && beforeBrace !== '*') names.push(beforeBrace); // `Default, { … }`
  } else if (!clause.includes('*') && clause !== '') {
    names.push(clause); // bare default import: `import Foo from '…'`
  }
  return names;
}

/** Assess one import against FR-1138: return a human violation string, or null if clean. */
function violationOf(file: string, imp: ParsedImport): string | null {
  if (FORBIDDEN_SYNC_SOURCE.test(imp.source)) {
    return `${file} imports the sync loop module '${imp.source}' — media must not couple to it (FR-1138)`;
  }
  for (const name of imp.names) {
    if (FORBIDDEN_SYNC_NAMES.test(name)) {
      return `${file} imports sync-scheduling symbol '${name}' from '${imp.source}' (FR-1138)`;
    }
  }
  if (SYNC_TRIGGER_MODULE.test(imp.source)) {
    for (const name of imp.names) {
      if (!ALLOWED_FROM_SYNC_TRIGGERS.has(name)) {
        return `${file} imports '${name}' from the sync-trigger module — only the shared intervals/ports are allowed (FR-1138)`;
      }
    }
  }
  return null;
}

describe('FR-1138 (app layer): the media loop borrows the sync triggers cadence, not their scheduling', () => {
  it('reads a non-empty set of media source files, including the two that touch bootstrap/triggers', () => {
    // Denominator (T-14). A renamed directory or a wrong glob makes every assertion below loop over
    // ZERO files and report green — the failure this repo has shipped eight times.
    const files = mediaSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(12);
    expect(files).toContain('triggers.ts'); // the mirror lives here
    expect(files).toContain('client.ts'); // and re-exports the two shared port types
  });

  it('no media source file couples to the sync loop; only the shared intervals/ports are borrowed', () => {
    const violations: string[] = [];
    let filesChecked = 0;
    let importsChecked = 0;
    let syncTriggerImportsChecked = 0;

    for (const file of mediaSourceFiles()) {
      filesChecked += 1;
      for (const imp of importsOf(file)) {
        importsChecked += 1;
        if (SYNC_TRIGGER_MODULE.test(imp.source)) syncTriggerImportsChecked += 1;
        const v = violationOf(file, imp);
        if (v !== null) violations.push(v);
      }
    }

    expect(violations).toEqual([]);
    // Denominators: the loop really walked files, really parsed imports, and the allowlist really had
    // a subject — at least one media file DID import from bootstrap/triggers, so the check is not
    // vacuously green over a module nobody touches.
    expect(filesChecked).toBeGreaterThanOrEqual(12);
    expect(importsChecked).toBeGreaterThanOrEqual(20);
    expect(syncTriggerImportsChecked).toBeGreaterThanOrEqual(1);
  });

  it('the parser finds the REAL mirror imports — positive control for the allowlist (T-17)', () => {
    // The fence above is satisfied trivially if the parser extracts nothing. This proves it reads the
    // exact four shared symbols out of `triggers.ts`, so the allowlist is doing real work.
    const fromSyncTriggers = importsOf('triggers.ts')
      .filter((imp) => SYNC_TRIGGER_MODULE.test(imp.source))
      .flatMap((imp) => imp.names);
    expect(new Set(fromSyncTriggers)).toEqual(ALLOWED_FROM_SYNC_TRIGGERS);

    // client.ts pulls the two port types (and nothing more) from the same module.
    const clientFromSyncTriggers = importsOf('client.ts')
      .filter((imp) => SYNC_TRIGGER_MODULE.test(imp.source))
      .flatMap((imp) => imp.names);
    expect(clientFromSyncTriggers.length).toBeGreaterThanOrEqual(2);
    for (const name of clientFromSyncTriggers)
      expect(ALLOWED_FROM_SYNC_TRIGGERS.has(name)).toBe(true);
  });

  it('the check FLAGS every forbidden shape — positive control for the fence (T-17)', () => {
    // Same `violationOf`, hostile inputs. Without this, a check that matched nothing would satisfy
    // the empty-violations assertion above and be believed.
    const forbidden: ParsedImport[] = [
      { source: '../bootstrap/triggers.js', names: ['createSyncTriggers'] }, // scheduling symbol
      { source: '../bootstrap/triggers.js', names: ['SyncTriggers'] }, // the loop's wiring type
      { source: '../bootstrap/triggers.js', names: ['*'] }, // namespace — pulls scheduling too
      { source: '../bootstrap/sync-client.js', names: ['createSyncClient'] }, // the sync client module
      { source: '../sync/loop.js', names: ['runSyncLoop'] }, // a core-shaped sync internal path
      { source: '@bolusi/core', names: ['SyncLoop'] }, // scheduling symbol from any source
    ];
    for (const imp of forbidden) {
      expect(violationOf('triggers.ts', imp), JSON.stringify(imp)).not.toBeNull();
    }
  });

  it('the legitimate mirror imports are NOT flagged — negative control (no false positive)', () => {
    const allowed: ParsedImport[] = [
      {
        source: '../bootstrap/triggers.js',
        names: ['APPEND_DEBOUNCE_MS', 'FOREGROUND_INTERVAL_MS'],
      },
      { source: '../bootstrap/triggers.js', names: ['AppStatePort', 'NetInfoPort'] },
      { source: './triggers.js', names: ['createMediaTriggers', 'MediaTriggers'] }, // media's own
      { source: '@bolusi/core', names: ['MediaDrainTrigger', 'TimerPort'] }, // not sync symbols
    ];
    for (const imp of allowed) {
      expect(violationOf('client.ts', imp), JSON.stringify(imp)).toBeNull();
    }
  });
});
