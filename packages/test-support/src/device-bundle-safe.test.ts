// The load-bearing guard for task 177: `@bolusi/test-support/device` must reach NO `node:`-builtin
// import — that is the whole reason the subpath exists. The `.` barrel re-exports `nodeColumnAead`
// (crypto/node-column-aead.ts → `import … from 'node:crypto'`), and Metro bundles every static
// dependency of an imported module, so the moment the on-device harness imports the barrel, `node:crypto`
// is dragged into the release Android bundle and `expo export --platform android` fails. The `/device`
// subpath re-exports only device-safe pieces; this test proves that claim doesn't silently rot.
//
// ── HOW IT GUARDS (and why it can't pass vacuously — §2.11) ─────────────────────────────────────
// It walks the SOURCE import graph from `src/device.ts`, following every relative import/export-from
// specifier, and asserts:
//   1. NO reachable specifier is a `node:` builtin (the direct hazard);
//   2. `crypto/node-column-aead.ts` — the file that imports `node:crypto` — is NOT reachable;
//   3. DENOMINATOR: the walk actually reached the device-safe modules it is supposed to (seed-200k,
//      prng, script, at-rest). Without (3) a walk that parsed ZERO specifiers would satisfy (1)+(2)
//      trivially — the empty-fixture family that has produced green-for-nothing guards in this repo.
//
// Source-graph, not dist: tsc emits the SAME import specifiers (verbatimModuleSyntax + NodeNext), and a
// source walk needs no build step, so this is a robust proxy for what Metro follows in `dist/`.
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import * as deviceEntry from './device.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Every module/export specifier a source file names (static import, side-effect import, export-from,
 * dynamic import). We check ALL of them for a `node:` prefix and FOLLOW the relative ones. */
function specifiersOf(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // import/export … from 'x'
    /\bimport\s*['"]([^'"]+)['"]/g, // side-effect import 'x'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('x')
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec !== undefined) specs.push(spec);
    }
  }
  return specs;
}

/** Resolve a relative `.js` specifier to its `.ts` source file (NodeNext specifiers point at emitted
 * `.js`; the source is the `.ts`). Returns null for a bare/non-relative specifier (a graph boundary). */
function resolveRelativeTs(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const abs = resolve(dirname(fromFile), spec);
  return abs.endsWith('.js') ? `${abs.slice(0, -'.js'.length)}.ts` : abs;
}

interface Walk {
  readonly reached: Set<string>;
  readonly nodeBuiltins: string[];
}

/** Breadth-first walk of the relative import graph rooted at `entry`, collecting reached source files
 * and every `node:`-builtin specifier seen anywhere in the graph. */
function walkGraph(entry: string): Walk {
  const reached = new Set<string>();
  const nodeBuiltins: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    const source = readFileSync(file, 'utf8');
    for (const spec of specifiersOf(source)) {
      if (spec.startsWith('node:')) {
        nodeBuiltins.push(`${relative(SRC_DIR, file)} → ${spec}`);
      }
      const next = resolveRelativeTs(file, spec);
      if (next !== null && !reached.has(next)) queue.push(next);
    }
  }
  return { reached, nodeBuiltins };
}

describe('@bolusi/test-support/device is device-bundle-safe (task 177)', () => {
  const walk = walkGraph(resolve(SRC_DIR, 'device.ts'));
  const reachedRel = [...walk.reached].map((file) => relative(SRC_DIR, file)).sort();

  test('reaches NO node: builtin import anywhere in its graph', () => {
    // The direct hazard. A single `import … from 'node:crypto'` anywhere in the reachable graph is what
    // breaks `expo export --platform android`. Empty list ⇒ clean.
    expect(walk.nodeBuiltins).toEqual([]);
  });

  test('does NOT reach crypto/node-column-aead (the node:crypto file the barrel re-exports)', () => {
    expect(reachedRel).not.toContain('crypto/node-column-aead.ts');
    // Nor the sec-meta child-process file, nor the noble/envelope crypto the barrel also carries.
    expect(reachedRel).not.toContain('sec-meta.ts');
    expect(reachedRel.some((f) => f.startsWith('crypto/'))).toBe(false);
  });

  test('DENOMINATOR: the walk actually reached the device-safe modules (not a vacuous parse)', () => {
    // Without this, a walk that parsed zero specifiers would pass the two negative checks above
    // trivially. These are the exact files the subpath must expose the bodies of.
    for (const expected of [
      'device.ts',
      'seed/seed-200k.ts',
      'determinism/prng.ts',
      'determinism/script.ts',
      'driver-conformance/at-rest.ts',
    ]) {
      expect(reachedRel, `device graph must reach ${expected}`).toContain(expected);
    }
  });

  test('the runtime exports the harness actually consumes are present and callable', () => {
    // Load-bearing check that the entry is not just node:crypto-free but exposes the real pieces:
    // registry.ts imports generateSeed200k/SEED_200K/mulberry32; at-rest-device-ctx imports
    // checkControlSeedIsWitnessed/checkDbAtRestIsCiphertext.
    expect(typeof deviceEntry.generateSeed200k).toBe('function');
    expect(typeof deviceEntry.mulberry32).toBe('function');
    expect(typeof deviceEntry.checkControlSeedIsWitnessed).toBe('function');
    expect(typeof deviceEntry.checkDbAtRestIsCiphertext).toBe('function');
    expect(deviceEntry.SEED_200K.totalOps).toBe(200_000);
    expect(deviceEntry.AT_REST_ENCRYPTED_COLUMNS).toHaveLength(11);
  });
});
