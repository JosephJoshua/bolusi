// The load-bearing guard for task 181: `@bolusi/test-support/chaos` must reach NO `node:`-builtin
// import — that is what lets the convergence rig bundle on Hermes for the on-device CHAOS-01 runner
// (apps/mobile) instead of living Node-only in `@bolusi/harness`. Metro bundles every static
// dependency of an imported module, so a single `node:` edge anywhere in the reachable graph breaks
// `expo export --platform android`. Unlike the `.` barrel — which re-exports `nodeColumnAead`
// (crypto/node-column-aead.ts → `node:crypto`) — the `/chaos` subpath pulls only `@bolusi/core`
// VALUES, `kysely`, the determinism leaves, and `crypto/noble-port.ts` (pure `@noble/*`), all
// `node:`-free. This test proves that claim doesn't silently rot.
//
// ── HOW IT GUARDS (and why it can't pass vacuously — §2.11) ─────────────────────────────────────
// It walks the SOURCE import graph from `src/chaos/index.ts`, following every RELATIVE import/
// export-from specifier (bare `@bolusi/*`, `kysely`, `@noble/*` are graph boundaries), and asserts:
//   1. NO reachable specifier is a `node:` builtin (the direct hazard);
//   2. `crypto/node-column-aead.ts` (the `node:crypto` file) is NOT reachable, and the ONLY `crypto/`
//      file reached is `noble-port.ts` — the rig's one crypto dependency;
//   3. DENOMINATOR: the walk actually reached the rig's own modules (device/oracle/convergence/
//      client-db) AND the leaves it must expose the bodies of. Without (3) a zero-parse walk would
//      satisfy (1)+(2) trivially — the empty-fixture family of green-for-nothing guards in this repo.
//
// Source-graph, not dist: tsc emits the SAME specifiers (verbatimModuleSyntax + NodeNext), so a
// source walk needs no build step and is a robust proxy for what Metro follows in `dist/`.
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import * as chaosEntry from './chaos/index.js';

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

describe('@bolusi/test-support/chaos is device-bundle-safe (task 181)', () => {
  const walk = walkGraph(resolve(SRC_DIR, 'chaos/index.ts'));
  const reachedRel = [...walk.reached].map((file) => relative(SRC_DIR, file)).sort();

  test('reaches NO node: builtin import anywhere in its graph', () => {
    // The direct hazard. A single `import … from 'node:*'` anywhere in the reachable graph is what
    // breaks `expo export --platform android`. Empty list ⇒ clean.
    expect(walk.nodeBuiltins).toEqual([]);
  });

  test('reaches only crypto/noble-port under crypto/ — never the node:crypto AEAD file', () => {
    expect(reachedRel).not.toContain('crypto/node-column-aead.ts');
    expect(reachedRel).not.toContain('sec-meta.ts');
    // The rig's single legitimate crypto dependency is noble-port (pure @noble/*). If any other
    // crypto/ file becomes reachable, this fails — that is the leak this guard is here to catch.
    expect(reachedRel.filter((f) => f.startsWith('crypto/'))).toEqual(['crypto/noble-port.ts']);
  });

  test('DENOMINATOR: the walk actually reached the rig modules (not a vacuous parse)', () => {
    // Without this, a walk that parsed zero specifiers would pass the two negative checks above
    // trivially. These are the exact files the subpath must expose the bodies of.
    for (const expected of [
      'chaos/index.ts',
      'chaos/device.ts',
      'chaos/oracle.ts',
      'chaos/convergence.ts',
      'chaos/client-db.ts',
      'chaos/identities.ts',
      'chaos/permissions.ts',
      'chaos/manifest.ts',
      'crypto/noble-port.ts',
      'determinism/prng.ts',
      'determinism/clock.ts',
      'determinism/id-source.ts',
      'determinism/keypair.ts',
    ]) {
      expect(reachedRel, `chaos graph must reach ${expected}`).toContain(expected);
    }
  });

  test('the runtime exports the on-device runner consumes are present and callable', () => {
    // Load-bearing check that the subpath is not just node:-free but exposes the real rig: the
    // apps/mobile CHAOS-01 env imports runConvergence + the oracle asserts + VirtualDevice.
    expect(typeof chaosEntry.runConvergence).toBe('function');
    expect(typeof chaosEntry.VirtualDevice).toBe('function');
    expect(typeof chaosEntry.mintIdentities).toBe('function');
    expect(typeof chaosEntry.buildGrantAllEvaluator).toBe('function');
    expect(typeof chaosEntry.toProjectionManifest).toBe('function');
    expect(typeof chaosEntry.assertConvergence).toBe('function');
    expect(typeof chaosEntry.assertBothFoldPaths).toBe('function');
  });
});
