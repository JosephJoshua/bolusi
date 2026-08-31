// Unit tests for the native SEC merge-gate classifier (task 194 / D22). `classifyInventoryForGate`
// and `owedIds` are the in-process successors to the `SEC_OWED_D21` assertion that ci-parity.mjs
// carried over a `security-sweep` CI log. The tower existed because the owed-forever SEC-AUTH-10 red
// shared one job conclusion with the real checks; splitting the job moves the owed/real distinction
// HERE, into a pure function over `auditInventory`'s structured result. So these controls are the
// whole safety case: they falsify each of the three orthogonal scopes the 166/172/184 patch chain
// forced, the sole-{SEC-AUTH-10} exemption, and the discharge-clean property — a classifier that
// cannot fail is worse than no classifier (CLAUDE.md §2.11).
import { expect, test } from 'vitest';

// prettier-ignore
// @ts-expect-error — plain .mjs script without type declarations (CI entry point)
import { auditInventory, classifyInventoryForGate, owedIds, SANCTIONED_OWED_IDS, SEC_FAIL_CODES } from '../../../scripts/sec-inventory.mjs';

const PENDING = `[${SEC_FAIL_CODES.PENDING_ALLOWLIST_NON_EMPTY}]`;

/** A guide whose body ids and §12 roll-up agree — the denominator `owedIds` intersects against. */
const CONSISTENT_GUIDE = [
  '| SEC-AUTH-09 | pin attempt throttled | … |',
  '| SEC-AUTH-10 | argon2id p95 within budget | … |',
  '| SEC-OPLOG-01 | forged signature rejected | … |',
  '| SEC-META-01 | id coverage | … |',
  '',
  '## 12. Test index',
  'Roll-up: AUTH 09–10 · OPLOG 01 · META 01. The chaos harness covers the rest.',
].join('\n');

// ── the sanctioned set is a hard singleton, not a growable list ───────────────────────────────────

test('SANCTIONED_OWED_IDS is exactly the single device-benchmark owed id — the sole exemption (D21/D22)', () => {
  // Falsification #2's "SEC-AUTH-10 is the ONLY id with the exemption": if a well-meaning edit ever
  // widened this set, a second permanent red could hide behind it. Pin the membership by value.
  expect([...SANCTIONED_OWED_IDS]).toEqual(['SEC-AUTH-10']);
});

// ── FAILURE-MODE scope (task 166): only [PENDING_ALLOWLIST_NON_EMPTY] is owed-eligible ───────────

test('a sole PENDING failure on the sanctioned id is owed, not real → gate stays GREEN', () => {
  const result = classifyInventoryForGate({
    failures: [`${PENDING} the SEC pending allowlist is NOT empty: SEC-AUTH-10 → owner`],
    pending: ['SEC-AUTH-10 → ai-docs/tasks/27-device-gates.md'],
  });
  expect(result.ok).toBe(true);
  expect(result.realFailures).toEqual([]);
  expect(result.owedFailures).toHaveLength(1);
  expect(result.owedIds).toEqual(['SEC-AUTH-10']);
  expect(result.unsanctionedOwedIds).toEqual([]);
});

test('a NON-pending code that NAMES the sanctioned id is REAL → gate RED (task 166)', () => {
  // The trap 166 closed: an [ALLOWLISTED_BUT_TITLED] regression that mentions SEC-AUTH-10 must not be
  // absorbed just because the id is sanctioned. Owed-eligibility is by failure MODE, not by id.
  const result = classifyInventoryForGate({
    failures: [
      `[${SEC_FAIL_CODES.ALLOWLISTED_BUT_TITLED}] SEC-AUTH-10 is on the pending allowlist but a test titles it`,
      `${PENDING} the SEC pending allowlist is NOT empty: SEC-AUTH-10 → owner`,
    ],
    pending: ['SEC-AUTH-10 → ai-docs/tasks/27-device-gates.md'],
  });
  expect(result.ok).toBe(false);
  expect(result.realFailures).toHaveLength(1);
  expect(result.owedFailures).toHaveLength(1);
});

// ── ID scope (task 184): owed ids must be a SUBSET of the sanctioned set ──────────────────────────

test('a SECOND owed id (a stranger on the allowlist) reds the gate (task 184)', () => {
  // The owed set is DERIVED from `pending`, so an extra pending id is a stranger the gate must not
  // tolerate — even though the only failure line is the sanctioned PENDING one.
  const result = classifyInventoryForGate({
    failures: [
      `${PENDING} the SEC pending allowlist is NOT empty: SEC-AUTH-10, SEC-OPLOG-01 → owners`,
    ],
    pending: [
      'SEC-AUTH-10 → ai-docs/tasks/27-device-gates.md',
      'SEC-OPLOG-01 → ai-docs/tasks/99-stranger.md',
    ],
  });
  expect(result.ok).toBe(false);
  expect(result.unsanctionedOwedIds).toEqual(['SEC-OPLOG-01']);
  expect(result.owedIds).toEqual(['SEC-AUTH-10', 'SEC-OPLOG-01']);
});

test('the owed id is read from before the arrow — an owner path cannot smuggle an id in', () => {
  // Defensive: an owner marker that itself contained a SEC id must not count as a second owed id.
  const result = classifyInventoryForGate({
    failures: [`${PENDING} owed: SEC-AUTH-10`],
    pending: ['SEC-AUTH-10 → ai-docs/tasks/SEC-OPLOG-01-decoy.md'],
  });
  expect(result.owedIds).toEqual(['SEC-AUTH-10']);
  expect(result.ok).toBe(true);
});

// ── STEP scope (task 154): a real SEC regression blocks even with an empty allowlist ──────────────

test('a real regression with NO pending entries reds the gate — nothing to be owed', () => {
  const result = classifyInventoryForGate({
    failures: [`[${SEC_FAIL_CODES.NO_PASSING_TEST}] SEC-OPLOG-01 has no passing test`],
    pending: [],
  });
  expect(result.ok).toBe(false);
  expect(result.realFailures).toHaveLength(1);
  expect(result.owedIds).toEqual([]);
});

// ── discharge-clean: emptying the allowlist greens both the classifier and the owed set ───────────

test('a clean result (no failures, no pending) is vacuously OK — the discharge state', () => {
  const result = classifyInventoryForGate({ failures: [], pending: [] });
  expect(result.ok).toBe(true);
  expect(result.owedIds).toEqual([]);
  expect(result.owedFailures).toEqual([]);
});

test('a DISCHARGED owed id (dropped from the allowlist) still passes — no hand-edit to follow', () => {
  // When task 27 lands the artifact, SEC-AUTH-10 leaves the allowlist and gains a titled test. The
  // gate must go green through the SAME code path, with nothing sanctioned-but-absent tripping it.
  const result = classifyInventoryForGate({
    failures: [],
    pending: [],
  });
  expect(result.ok).toBe(true);
});

// ── owedIds derivation: the owed set tracks allowlist ∩ guide, never a literal ────────────────────

test('owedIds is the intersection of the allowlist keys and the guide ids, sorted', () => {
  expect(owedIds(CONSISTENT_GUIDE, { 'SEC-AUTH-10': 'owner' })).toEqual(['SEC-AUTH-10']);
  // two owed ids come back sorted, proving it is not a hardcoded singleton
  expect(owedIds(CONSISTENT_GUIDE, { 'SEC-OPLOG-01': 'o', 'SEC-AUTH-09': 'o' })).toEqual([
    'SEC-AUTH-09',
    'SEC-OPLOG-01',
  ]);
  // an allowlist key the guide does not define is not owed by the guide
  expect(owedIds(CONSISTENT_GUIDE, { 'SEC-NOPE-99': 'owner' })).toEqual([]);
  // an empty allowlist owes nothing — the discharge end-state
  expect(owedIds(CONSISTENT_GUIDE, {})).toEqual([]);
});

// ── integration: the real auditInventory result flows through the classifier ──────────────────────

test('production shape: the owed id allowlisted + everything else passing → gate GREEN, owed reports it', () => {
  const result = auditInventory({
    guideText: CONSISTENT_GUIDE,
    allowlist: { 'SEC-AUTH-10': 'ai-docs/tasks/27-device-gates.md' },
    reports: [
      {
        lane: 'fixture',
        report: {
          testResults: [
            {
              assertionResults: [
                { fullName: 'SEC-AUTH-09 pin attempt throttled', status: 'passed' },
                { fullName: 'SEC-OPLOG-01 forged signature rejected', status: 'passed' },
                { fullName: 'SEC-META-01 every id has a producer', status: 'passed' },
              ],
            },
          ],
        },
      },
    ],
  });
  // auditInventory alone is red (pending non-empty); the GATE classifier tolerates exactly that.
  expect(result.ok).toBe(false);
  const gate = classifyInventoryForGate(result);
  expect(gate.ok).toBe(true);
  expect(gate.owedIds).toEqual(['SEC-AUTH-10']);
  expect(gate.realFailures).toEqual([]);
});

test('production shape with a real regression: a non-owed id fails its test → gate RED', () => {
  const result = auditInventory({
    guideText: CONSISTENT_GUIDE,
    allowlist: { 'SEC-AUTH-10': 'ai-docs/tasks/27-device-gates.md' },
    reports: [
      {
        lane: 'fixture',
        report: {
          testResults: [
            {
              assertionResults: [
                { fullName: 'SEC-AUTH-09 pin attempt throttled', status: 'failed' },
                { fullName: 'SEC-OPLOG-01 forged signature rejected', status: 'passed' },
                { fullName: 'SEC-META-01 every id has a producer', status: 'passed' },
              ],
            },
          ],
        },
      },
    ],
  });
  const gate = classifyInventoryForGate(result);
  expect(gate.ok).toBe(false);
  expect(gate.realFailures.length).toBeGreaterThan(0);
});
