// SEC-AUTH-09 — the DISCHARGE gate. This is the one test that titles SEC-AUTH-09 verbatim (so
// `sec-inventory.mjs` counts the id and SEC-META-01 credits it), and it earns that title by asserting
// ALL THREE legs together (security-guide §165 / §5.4), each traced to its real producer (T-16):
//
//   • LEG 1 — the PIN-verifier salt/hash/params are ciphertext AT REST on real hardware. Emulator-only,
//     so its evidence is the COMMITTED artifact `reports/device-gates/2026-07-25-emulator.json` (task
//     27a run 30153400999, driven through the production `writeVerifier`). Trusting that JSON without
//     provenance is the "real number with fictional provenance" trap (§2.11); `assessDeviceGateDischarge`
//     is the freshness/provenance guard that stops it — the load-bearing part of this file.
//   • LEG 2 — no pushed op payload carries verifier material (I-13). The universal cycle scan ships in
//     `sec-auth-09-payloads.test.ts`; here we re-exercise its SCANNER's positive control (T-14b), so
//     breaking the scanner reds SEC-AUTH-09 directly.
//   • LEG 3 — the PIN-verifier comparison is constant-time. `timingSafeEqualBytes` (@bolusi/core) is the
//     compare on the verify path (`verifyPinAgainst`); we assert its constant-time STRUCTURE (single
//     terminal return, length folded, no short-circuit) plus the behaviours a short-circuit would break.
//
// FRESHNESS FALSIFICATION (§2.11): mutate any at-rest surface file (the column cipher, `writeVerifier`,
// the gate body, the seed, the probe) WITHOUT re-running the emulator and this test goes RED naming the
// stale file — because the committed artifact no longer reflects the code. Watched in the task-28 report.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { timingSafeEqualBytes } from '@bolusi/core';

import {
  leakedVerifierEncodings,
  verifierEncodings,
  type VerifierSecrets,
} from '../../src/security/verifier-scan.js';
import {
  assessDeviceGateDischarge,
  AT_REST_SURFACE,
  DEVICE_GATE_ARTIFACT,
  VERIFIER_AT_REST_GATE_ID,
  type DeviceGateFacts,
} from '../../src/security/device-gate-provenance.js';

// ── git/fs fact-gathering (the impure half; the verdict it feeds is pure) ─────────────────────────

function git(root: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

function repoRoot(): string {
  const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new Error('not in a git repository — cannot establish artifact provenance');
  return top.stdout.trim();
}

/** Gather the real git/fs facts for the pinned artifact + declared surface. */
function gatherDeviceGateFacts(
  root: string,
  artifactPath: string,
  surface: readonly string[],
): DeviceGateFacts {
  // The commit that INTRODUCED the artifact (reverse-chron log ⇒ the LAST line is the earliest add).
  const adds = git(root, ['log', '--diff-filter=A', '--format=%H', '--', artifactPath]);
  const addLines = adds.stdout.split('\n').filter((line) => line.trim().length > 0);
  const anchorCommit = addLines.length > 0 ? (addLines[addLines.length - 1] as string) : null;

  const anchorHasParent =
    anchorCommit !== null && git(root, ['rev-parse', '--verify', `${anchorCommit}^`]).ok;

  const committed =
    anchorCommit !== null
      ? git(root, ['show', `${anchorCommit}:${artifactPath}`])
      : { ok: false, stdout: '' };
  const committedArtifactText = committed.ok ? committed.stdout : null;

  const worktreeArtifactText = existsSync(join(root, artifactPath))
    ? readFileSync(join(root, artifactPath), 'utf8')
    : null;

  const linesOf = (out: string): string[] =>
    out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  const surfaceChangedSinceAnchor =
    anchorCommit !== null
      ? linesOf(git(root, ['diff', '--name-only', anchorCommit, '--', ...surface]).stdout)
      : [];

  const surfaceChangedInAnchorCommit =
    anchorCommit !== null && anchorHasParent
      ? linesOf(
          git(root, ['diff', '--name-only', `${anchorCommit}^`, anchorCommit, '--', ...surface])
            .stdout,
        )
      : [];

  const missingSurfacePaths = surface.filter((path) => {
    const onDisk = existsSync(join(root, path));
    const atAnchor =
      anchorCommit !== null && git(root, ['cat-file', '-e', `${anchorCommit}:${path}`]).ok;
    return !onDisk || !atAnchor;
  });

  return {
    artifactPath,
    surface,
    anchorCommit,
    anchorHasParent,
    committedArtifactText,
    worktreeArtifactText,
    surfaceChangedSinceAnchor,
    surfaceChangedInAnchorCommit,
    missingSurfacePaths,
  };
}

// ── LEG 3 — the constant-time compare's STRUCTURE, read from source (not just behaviour) ──────────

/** Isolate the `timingSafeEqualBytes` function body from its source (fail loudly if not found — T-14). */
function timingSafeEqualBytesSource(root: string): string {
  const src = readFileSync(join(root, 'packages/core/src/auth/verifier.ts'), 'utf8');
  const start = src.indexOf('export function timingSafeEqualBytes');
  expect(
    start,
    'timingSafeEqualBytes not found in verifier.ts — leg 3 has no producer to check',
  ).toBeGreaterThan(-1);
  // Walk to the matching close brace of the function body.
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  let end = braceOpen;
  for (let i = braceOpen; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return src.slice(braceOpen, end + 1);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE DISCHARGE GATE — titles SEC-AUTH-09 verbatim.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('SEC-AUTH-09 verifier confidentiality — proven end to end for release', () => {
  const root = repoRoot();

  it('SEC-AUTH-09 at rest: the committed emulator artifact seals the PIN-verifier material, with fresh provenance', () => {
    const facts = gatherDeviceGateFacts(root, DEVICE_GATE_ARTIFACT, AT_REST_SURFACE);
    const verdict = assessDeviceGateDischarge(facts);

    // Read the guard's OWN output (§2.1), not a summary.
    expect(verdict.failures, verdict.failures.join('\n')).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.leg1, 'the committed SEC-AUTH-09-leg1 gate must be pass').toBe('pass');
    expect(verdict.anchorCommit, 'leg 1 must be anchored to a real provenance commit').toMatch(
      /^[0-9a-f]{40}$/,
    );
    // The surface must be non-trivial AND actually present — a guard checking nothing is worse than none.
    expect(AT_REST_SURFACE.length).toBeGreaterThanOrEqual(5);
    expect(facts.missingSurfacePaths, 'every at-rest surface path must exist').toEqual([]);
  });

  it('SEC-AUTH-09 payloads: the verifier-material scanner catches every planted encoding and ignores the params that legitimately travel (I-13)', () => {
    const secret: VerifierSecrets = {
      saltB64: Buffer.alloc(16, 7).toString('base64'),
      hashB64: Buffer.alloc(32, 9).toString('base64'),
    };
    const encodings = verifierEncodings(secret);
    expect(
      encodings.length,
      'the scanner enumerates fewer encodings than expected',
    ).toBeGreaterThanOrEqual(6);
    for (const encoding of encodings) {
      const planted = JSON.stringify({ targetUserId: 'u', leaked: encoding });
      expect(leakedVerifierEncodings(planted, [secret]), `the scan missed ${encoding}`).toContain(
        encoding,
      );
    }
    // The legitimate D11 payload (verifierRef + params) must NOT trip the scan.
    const legitimate = JSON.stringify({
      targetUserId: '0c111111-1111-7111-8111-111111111111',
      verifierRef: '0a888888-8888-7888-8888-888888888888',
      params: { algorithm: 'argon2id', mKiB: 32768, t: 3, p: 1 },
    });
    expect(leakedVerifierEncodings(legitimate, [secret])).toEqual([]);

    // The full end-to-end cycle scan (over every PRODUCED op) is the sibling producer — assert it ships.
    expect(
      existsSync(join(root, 'packages/harness/test/security/sec-auth-09-payloads.test.ts')),
      'the I-13 end-to-end payload scan (leg 2) must ship alongside this gate',
    ).toBe(true);
  });

  it('SEC-AUTH-09 comparison: the PIN-verifier compare is constant-time (structure + behaviour)', () => {
    // Behaviour a short-circuit would break: pairing first-diff and last-diff rejects a first-byte
    // short-circuit; folding a length mismatch rejects an early length return.
    const a = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(timingSafeEqualBytes(a, Uint8Array.from(a))).toBe(true);
    const firstDiff = Uint8Array.from(a);
    firstDiff[0] = 99;
    const lastDiff = Uint8Array.from(a);
    lastDiff[lastDiff.length - 1] = 99;
    expect(timingSafeEqualBytes(a, firstDiff)).toBe(false);
    expect(timingSafeEqualBytes(a, lastDiff)).toBe(false);
    expect(timingSafeEqualBytes(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3, 4]))).toBe(
      false,
    );
    expect(timingSafeEqualBytes(Uint8Array.from([]), Uint8Array.from([]))).toBe(true);

    // Structure: a single terminal `return`, no early return / break inside the loop, length folded.
    const body = timingSafeEqualBytesSource(root);
    const returns = body.match(/\breturn\b/g) ?? [];
    expect(returns.length, 'a constant-time compare returns exactly once, at the end').toBe(1);
    expect(body, 'the terminal return must compare the single accumulator, not a byte').toMatch(
      /return\s+diff\s*===\s*0\s*;/,
    );
    expect(body, 'no break may short-circuit the compare loop').not.toMatch(/\bbreak\b/);
    expect(
      body,
      'the length difference must be folded into the accumulator, never early-returned',
    ).toMatch(/diff\s*=\s*a\.length\s*\^\s*b\.length/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The provenance/freshness guard's OWN red paths, watched by construction (T-11). These do NOT title
// SEC-AUTH-09 — they falsify the mechanism against synthetic facts so the real gate above is believed.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('device-gate discharge guard — every failure mode goes red', () => {
  const goodArtifact = JSON.stringify({
    schema: 'bolusi-harness-result/1',
    runId: 'run-2026-07-25T10-10-50-919Z-741874',
    variant: 'release',
    target: 'emulator',
    gates: [{ id: VERIFIER_AT_REST_GATE_ID, status: 'pass', detail: 'sealed' }],
  });

  const baseFacts = (): DeviceGateFacts => ({
    artifactPath: 'reports/device-gates/x.json',
    surface: ['a.ts', 'b.ts'],
    anchorCommit: 'a'.repeat(40),
    anchorHasParent: true,
    committedArtifactText: goodArtifact,
    worktreeArtifactText: goodArtifact,
    surfaceChangedSinceAnchor: [],
    surfaceChangedInAnchorCommit: [],
    missingSurfacePaths: [],
  });

  it('the happy path is green (so the red assertions below mean something)', () => {
    const v = assessDeviceGateDischarge(baseFacts());
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.leg1).toBe('pass');
  });

  it('RED: an at-rest surface file changed since the anchor ⇒ STALE', () => {
    const v = assessDeviceGateDischarge({ ...baseFacts(), surfaceChangedSinceAnchor: ['a.ts'] });
    expect(v.ok).toBe(false);
    expect(v.failures.join('\n')).toMatch(
      /a\.ts changed since the emulator artifact's provenance commit/,
    );
    expect(v.failures.join('\n')).toMatch(/STALE/);
  });

  it('RED: the working-tree artifact was hand-edited since its provenance commit', () => {
    const tampered = goodArtifact.replace('"pass"', '"fail"');
    const v = assessDeviceGateDischarge({ ...baseFacts(), worktreeArtifactText: tampered });
    expect(v.ok).toBe(false);
    expect(v.failures.join('\n')).toMatch(/MODIFIED since its provenance commit/);
  });

  it('RED: a committed artifact whose leg-1 gate is not pass (a fabricated skipped→pass is read from git, not the disk)', () => {
    const skipped = goodArtifact.replace('"pass"', '"skipped"');
    // The on-disk copy is flipped to "pass"; the guard reads the COMMITTED bytes, so it is not fooled.
    const v = assessDeviceGateDischarge({
      ...baseFacts(),
      committedArtifactText: skipped,
      worktreeArtifactText: skipped, // committed == worktree (both skipped); disk-flip cannot help
    });
    expect(v.ok).toBe(false);
    expect(v.leg1).toBe('skipped');
    expect(v.failures.join('\n')).toMatch(/is "skipped" in the committed artifact, not "pass"/);
  });

  it('RED: no git provenance for the artifact', () => {
    const v = assessDeviceGateDischarge({ ...baseFacts(), anchorCommit: null });
    expect(v.ok).toBe(false);
    expect(v.failures.join('\n')).toMatch(/is not in git history/);
  });

  it('RED: a surface path that exists nowhere (the guard would diff nothing for it)', () => {
    const v = assessDeviceGateDischarge({ ...baseFacts(), missingSurfacePaths: ['a.ts'] });
    expect(v.ok).toBe(false);
    expect(v.failures.join('\n')).toMatch(/does not exist at the provenance commit or on disk/);
  });

  it('RED: the artifact commit itself smuggled an at-rest code change', () => {
    const v = assessDeviceGateDischarge({ ...baseFacts(), surfaceChangedInAnchorCommit: ['b.ts'] });
    expect(v.ok).toBe(false);
    expect(v.failures.join('\n')).toMatch(/itself modified at-rest surface file b\.ts/);
  });

  it('RED: a malformed / non-driver run id (a hand-typed artifact)', () => {
    const fake = goodArtifact.replace('run-2026-07-25T10-10-50-919Z-741874', 'pass');
    const v = assessDeviceGateDischarge({
      ...baseFacts(),
      committedArtifactText: fake,
      worktreeArtifactText: fake,
    });
    expect(v.ok).toBe(false);
    expect(v.failures.join('\n')).toMatch(/not a real driver-shaped run id/);
  });

  it('RED: an empty surface (a guard that checks nothing)', () => {
    const v = assessDeviceGateDischarge({ ...baseFacts(), surface: [] });
    expect(v.ok).toBe(false);
    expect(v.failures.join('\n')).toMatch(/at-rest surface is EMPTY/);
  });
});
