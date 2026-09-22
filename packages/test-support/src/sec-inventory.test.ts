// Unit tests for the sec:sweep entry scripts (task 28): the SEC inventory, the dependency pin
// audit, and the `.env.example` parser. Same shape as `lockfile-checks.test.ts` — the scripts are
// plain `.mjs` CI entry points, imported here so their NEGATIVE CONTROLS run against fixtures
// instead of against a deliberately broken repo.
//
// The controls are the point. An inventory that cannot fail is worse than no inventory
// (CLAUDE.md §2.11), so every rule below is exercised in both directions: a clean fixture passes,
// and a fixture with exactly one thing wrong names exactly that thing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { expect, test } from 'vitest';

// @ts-expect-error — plain .mjs script without type declarations (CI entry point)
import { auditInventory, parseGuideIds, parseRollupIds } from '../../../scripts/sec-inventory.mjs';
// @ts-expect-error — plain .mjs script without type declarations (CI entry point)
import { partitionFailures, pendingOwedIds } from '../../../scripts/sec-inventory.mjs';
// @ts-expect-error — plain .mjs script without type declarations (CI entry point)
import { SEC_FAIL_CODES } from '../../../scripts/sec-inventory.mjs';
// @ts-expect-error — plain .mjs script without type declarations (CI entry point)
import { auditDependencies, parseCatalog } from '../../../scripts/dependency-audit.mjs';
// @ts-expect-error — plain .mjs script without type declarations (CI entry point)
import { parseEnvExample } from '../../../scripts/secrets-scan.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const realGuide = readFileSync(join(REPO_ROOT, 'ai-docs/security-guide.md'), 'utf8');
const realWorkspace = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
const realLockfile = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
const realNpmrc = readFileSync(join(REPO_ROOT, '.npmrc'), 'utf8');

/** A minimal guide whose body ids and §12 roll-up agree — the control the fixtures deviate from. */
const CONSISTENT_GUIDE = [
  '| SEC-OPLOG-01 | forged signature rejected | … |',
  '| SEC-OPLOG-02 | replayed op is inert | … |',
  '| SEC-META-01 | id coverage | … |',
  '',
  '## 12. Test index',
  'Roll-up: OPLOG 01–02 · META 01. The chaos harness covers the rest.',
].join('\n');

/** A vitest JSON report with the given `fullName`/`status` pairs. */
function report(assertions: readonly [string, string][]) {
  return {
    testResults: [
      {
        assertionResults: assertions.map(([fullName, status]) => ({ fullName, status })),
      },
    ],
  };
}

const passingReport = report([
  ['SEC-OPLOG-01 forged signature rejected', 'passed'],
  ['SEC-OPLOG-02 replayed op is inert', 'passed'],
  ['SEC-META-01 every id has a producer', 'passed'],
]);

// ── the §12 roll-up as the denominator ──────────────────────────────────────────────────────────

test('roll-up parser expands the §12 ranges and reports the entries it read', () => {
  const parsed = parseRollupIds(CONSISTENT_GUIDE);
  expect(parsed.ids).toEqual(['SEC-META-01', 'SEC-OPLOG-01', 'SEC-OPLOG-02']);
  expect(parsed.entries).toEqual(['OPLOG 01-02', 'META 01']);
});

test('roll-up parser returns an EMPTY set when the Roll-up line is missing, so the caller can fail loudly', () => {
  expect(parseRollupIds('## 12. Test index\nno roll-up here.').ids).toEqual([]);
});

test('inventory passes when the guide, the roll-up, and the passing tests all agree', () => {
  const result = auditInventory({
    guideText: CONSISTENT_GUIDE,
    allowlist: {},
    reports: [{ lane: 'fixture', report: passingReport }],
  });
  expect(result.failures).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.checked).toMatchObject({ guideIds: 3, rollupIds: 3, idsWithPass: 3 });
});

test('inventory FAILS when an id in the guide body is missing from the §12 roll-up (doc drift)', () => {
  const drifted = CONSISTENT_GUIDE.replace('Roll-up: OPLOG 01–02', 'Roll-up: OPLOG 01–01');
  const result = auditInventory({
    guideText: drifted,
    allowlist: {},
    reports: [{ lane: 'fixture', report: passingReport }],
  });
  expect(result.ok).toBe(false);
  expect(result.failures.join('\n')).toContain(
    'SEC-OPLOG-02 appears in security-guide.md but NOT in the §12 roll-up',
  );
});

test('inventory FAILS when the §12 roll-up declares an id the guide body never defines', () => {
  const drifted = CONSISTENT_GUIDE.replace('Roll-up: OPLOG 01–02', 'Roll-up: OPLOG 01–03');
  const result = auditInventory({
    guideText: drifted,
    allowlist: {},
    reports: [
      {
        lane: 'fixture',
        report: report([
          ...([
            ['SEC-OPLOG-01 forged signature rejected', 'passed'],
            ['SEC-OPLOG-02 replayed op is inert', 'passed'],
            ['SEC-META-01 every id has a producer', 'passed'],
          ] as [string, string][]),
        ]),
      },
    ],
  });
  expect(result.ok).toBe(false);
  expect(result.failures.join('\n')).toContain(
    'SEC-OPLOG-03 is declared by the §12 roll-up but appears nowhere else',
  );
});

// ── passes, not presence ────────────────────────────────────────────────────────────────────────

test('inventory FAILS when a SEC-titled test FAILED — the negative control that proves status is read, not grepped', () => {
  const result = auditInventory({
    guideText: CONSISTENT_GUIDE,
    allowlist: {},
    reports: [
      {
        lane: 'fixture',
        report: report([
          ['SEC-OPLOG-01 forged signature rejected', 'failed'],
          ['SEC-OPLOG-02 replayed op is inert', 'passed'],
          ['SEC-META-01 every id has a producer', 'passed'],
        ]),
      },
    ],
  });
  expect(result.ok).toBe(false);
  expect(result.failures.join('\n')).toContain(
    'SEC-OPLOG-01 has a SEC-titled test that did not pass',
  );
});

test('inventory FAILS when a SEC-titled test was SKIPPED — a skip is not a pass', () => {
  const result = auditInventory({
    guideText: CONSISTENT_GUIDE,
    allowlist: {},
    reports: [
      {
        lane: 'fixture',
        report: report([
          ['SEC-OPLOG-01 forged signature rejected', 'skipped'],
          ['SEC-OPLOG-02 replayed op is inert', 'passed'],
          ['SEC-META-01 every id has a producer', 'passed'],
        ]),
      },
    ],
  });
  expect(result.ok).toBe(false);
  expect(result.failures.join('\n')).toContain(
    'SEC-OPLOG-01 has a SEC-titled test that did not pass',
  );
});

test('inventory FAILS when a lane produced no assertions at all — a report of nothing is not coverage', () => {
  const result = auditInventory({
    guideText: CONSISTENT_GUIDE,
    allowlist: {},
    reports: [{ lane: 'fixture', report: { testResults: [] } }],
  });
  expect(result.ok).toBe(false);
  expect(result.failures.join('\n')).toContain('contained ZERO assertions');
});

test('inventory FAILS while the pending allowlist is non-empty, and names the owed ids', () => {
  const result = auditInventory({
    guideText: CONSISTENT_GUIDE,
    allowlist: { 'SEC-OPLOG-02': 'ai-docs/tasks/27-device-gates.md' },
    reports: [
      {
        lane: 'fixture',
        report: report([
          ['SEC-OPLOG-01 forged signature rejected', 'passed'],
          ['SEC-META-01 every id has a producer', 'passed'],
        ]),
      },
    ],
  });
  expect(result.ok).toBe(false);
  expect(result.pending).toEqual(['SEC-OPLOG-02 → ai-docs/tasks/27-device-gates.md']);
  expect(result.failures.join('\n')).toContain('the SEC pending allowlist is NOT empty');
});

test('inventory FAILS when an id is BOTH allowlisted and titled — the row and the title cannot both be true', () => {
  const result = auditInventory({
    guideText: CONSISTENT_GUIDE,
    allowlist: { 'SEC-OPLOG-02': 'ai-docs/tasks/27-device-gates.md' },
    reports: [{ lane: 'fixture', report: passingReport }],
  });
  expect(result.failures.join('\n')).toContain(
    'SEC-OPLOG-02 is on the pending allowlist (owed by ai-docs/tasks/27-device-gates.md) but a test titles it',
  );
});

test('every inventory FAIL line begins with a known machine-readable [CODE] (task 166)', () => {
  // 166: the owed/real split scopes by FAILURE MODE, so it depends on every FAIL line carrying
  // exactly one bracketed code as its first token. Provoke several distinct modes at once and
  // assert each failure is `[CODE] …` with CODE a member of SEC_FAIL_CODES — an uncoded line is
  // classified as REAL (blocking) by `partitionFailures`, so a missing code is a real break.
  // (Task 194 moved that classification from a CI-log oracle into `partitionFailures` below.)
  const result = auditInventory({
    guideText: CONSISTENT_GUIDE,
    allowlist: { 'SEC-OPLOG-02': 'ai-docs/tasks/27-device-gates.md' },
    reports: [
      {
        lane: 'fixture',
        report: report([
          ['SEC-OPLOG-01 forged signature rejected', 'failed'], // -> TEST_NOT_PASSING
          ['SEC-OPLOG-02 replayed op is inert', 'passed'], // titles an ALLOWLISTED id -> ALLOWLISTED_BUT_TITLED
          // SEC-META-01 absent -> NO_PASSING_TEST; pending non-empty -> PENDING_ALLOWLIST_NON_EMPTY
        ]),
      },
    ],
  });
  expect(result.failures.length).toBeGreaterThan(0);
  const known = new Set(Object.values(SEC_FAIL_CODES) as string[]);
  const seen = new Set<string>();
  for (const failure of result.failures as string[]) {
    const match = failure.match(/^\[([A-Z0-9_]+)\] /);
    expect(match, `FAIL carries no [CODE]: ${failure}`).not.toBeNull();
    const code = match?.[1] as string;
    expect(known.has(code), `unknown code in: ${failure}`).toBe(true);
    seen.add(code);
  }
  // T-14 denominator: the fixture must actually exercise several distinct modes, or "all coded" is
  // vacuous. It provokes at least the pending, allowlisted-but-titled, failed-test and no-pass modes.
  expect(seen.has(SEC_FAIL_CODES.PENDING_ALLOWLIST_NON_EMPTY)).toBe(true);
  expect(seen.has(SEC_FAIL_CODES.ALLOWLISTED_BUT_TITLED)).toBe(true);
  expect(seen.size).toBeGreaterThanOrEqual(3);
});

// ── owed vs blocking (task 194) ──────────────────────────────────────────────────────────────────
//
// These replace what scripts/ci-parity.mjs used to do by parsing CI logs. The classification now
// happens where the failures are produced, so the two CI jobs (`security-sweep`, required, and
// excluded from its exit status) carries it structurally. The controls below are load-bearing:
// they prove the split cannot quietly absorb a real regression into the standing red.

test('the owed bucket accepts ONLY the non-empty-allowlist mode; other modes are blocking', () => {
  const { owed, real } = partitionFailures([
    `[${SEC_FAIL_CODES.PENDING_ALLOWLIST_NON_EMPTY}] the SEC pending allowlist is NOT empty`,
    `[${SEC_FAIL_CODES.NO_PASSING_TEST}] an id has no passing test`,
    `[${SEC_FAIL_CODES.ROLLUP_MISSING_ID}] doc drift`,
  ]);
  expect(owed).toHaveLength(1);
  expect(real).toHaveLength(2);
});

test('a DIFFERENT failure mode naming an already-owed id still BLOCKS — it is not absorbed (task 166)', () => {
  // The regression this whole design exists to prevent: an id may be exempt for its allowlist row
  // and for nothing else. Here the SAME id that is legitimately owed also trips a real bookkeeping
  // fault; that second finding must land in the blocking bucket or the standing red would hide it.
  const owedId = 'SEC-OPLOG-02';
  const { owed, real } = partitionFailures([
    `[${SEC_FAIL_CODES.PENDING_ALLOWLIST_NON_EMPTY}] the SEC pending allowlist is NOT empty: ${owedId} → t.md`,
    `[${SEC_FAIL_CODES.ALLOWLISTED_BUT_TITLED}] ${owedId} is on the pending allowlist but a test titles it`,
  ]);
  expect(owed).toHaveLength(1);
  expect(real).toEqual([
    `[${SEC_FAIL_CODES.ALLOWLISTED_BUT_TITLED}] ${owedId} is on the pending allowlist but a test titles it`,
  ]);
});

test('an unrecognised or absent failure code is treated as BLOCKING — the partition fails closed', () => {
  // A new failure mode added later must block on the day it is introduced, without anyone
  // remembering to register it. Defaulting the other way is how a gate goes green for nothing.
  const { owed, real } = partitionFailures([
    '[SOME_MODE_INVENTED_LATER] a mode this code has never heard of',
    'a FAIL line with no bracketed code at all',
  ]);
  expect(owed).toHaveLength(0);
  expect(real).toHaveLength(2);
});

test('the owed set is derived from the allowlist, and is empty when the allowlist is', () => {
  const guideText = CONSISTENT_GUIDE;
  expect(pendingOwedIds({ guideText, allowlist: { 'SEC-OPLOG-02': 'owner.md' } })).toEqual([
    { id: 'SEC-OPLOG-02', owner: 'owner.md' },
  ]);
  expect(pendingOwedIds({ guideText, allowlist: {} })).toEqual([]);
});

test('an id allowlisted but absent from the guide is not counted as owed', () => {
  // The guide is the denominator. A stale allowlist row for an id the guide no longer defines must
  // not invent an owed id out of nothing — otherwise the expected-red job could never go green.
  expect(
    pendingOwedIds({ guideText: CONSISTENT_GUIDE, allowlist: { 'SEC-GONE-99': 'owner.md' } }),
  ).toEqual([]);
});

test('a real finding alongside an owed one still fails the sweep, and the owed one alone does not', () => {
  // End-to-end over auditInventory: this is exactly the two CI outcomes the split has to produce.
  const owedOnly = auditInventory({
    guideText: CONSISTENT_GUIDE,
    allowlist: { 'SEC-OPLOG-02': 'owner.md' },
    reports: [
      {
        lane: 'fixture',
        report: report([
          ['SEC-OPLOG-01 forged signature rejected', 'passed'],
          ['SEC-META-01 every id has a producer', 'passed'],
        ]),
      },
    ],
  });
  expect(owedOnly.ok).toBe(false); // the inventory still reports it …
  expect(partitionFailures(owedOnly.failures).real).toEqual([]); // … but nothing blocking remains.

  const withRegression = auditInventory({
    guideText: CONSISTENT_GUIDE,
    allowlist: { 'SEC-OPLOG-02': 'owner.md' },
    reports: [
      {
        lane: 'fixture',
        report: report([['SEC-OPLOG-01 forged signature rejected', 'passed']]),
      },
    ],
  });
  expect(partitionFailures(withRegression.failures).real.join('\n')).toContain(
    SEC_FAIL_CODES.NO_PASSING_TEST,
  );
});

// ── the real guide ──────────────────────────────────────────────────────────────────────────────

test('the real security-guide body and its §12 roll-up declare the SAME 61 SEC ids (the inventory denominator)', () => {
  const body = parseGuideIds(realGuide);
  const rollup = parseRollupIds(realGuide).ids;
  // 61 is the declared denominator: the §12 roll-up ranges expanded, incl. SEC-DEV-08 (Android
  // backup exclusion, task 58), SEC-TENANT-06 (device→store write scope, task 157), SEC-MEDIA-07/08
  // (client pre-display hash + server mediaRef→signer binding, task 153), and SEC-MEDIA-09 (captured
  // media FILES encrypted at rest, task 158 — MEDIA 01–09). Body ids are parsed from the §6.5-style
  // surface tables; roll-up ids from the §12 range line — two independent reads of the guide.
  // Asserting they are EQUAL is the cross-check task 115 restored (DEV 01–07 while SEC-DEV-08 ships
  // reds HERE, not silently); the exact 61 makes a multi-id deletion — which the old `>50` floor
  // waved through — fail too.
  expect(body).toHaveLength(61);
  expect(rollup).toHaveLength(61);
  expect(rollup).toEqual(body);
});

// ── dependency audit ────────────────────────────────────────────────────────────────────────────

test('catalog parser reads every pinned entry out of the real pnpm-workspace.yaml', () => {
  const catalog = parseCatalog(realWorkspace);
  expect(Object.keys(catalog).length).toBeGreaterThan(30);
  expect(catalog['kysely']).toBe('0.29.3');
  expect(catalog['@op-engineering/op-sqlite']).toBe('17.1.2');
});

test('dependency audit passes on the real repo', () => {
  const result = auditDependencies({
    workspaceYaml: realWorkspace,
    lockfileText: realLockfile,
    npmrcText: realNpmrc,
    guideText: realGuide,
  });
  expect(result.failures).toEqual([]);
});

test('dependency audit FAILS on a caret range for a load-bearing pin', () => {
  const loosened = realWorkspace.replace('canonicalize: 3.0.0', 'canonicalize: ^3.0.0');
  const result = auditDependencies({
    workspaceYaml: loosened,
    lockfileText: realLockfile,
    npmrcText: realNpmrc,
    guideText: realGuide,
  });
  expect(result.failures.join('\n')).toContain('canonicalize is pinned as "^3.0.0" — a RANGE');
});

test('dependency audit FAILS on a wrong exact version for a load-bearing pin', () => {
  const bumped = realWorkspace.replace('kysely: 0.29.3', 'kysely: 0.30.0');
  const result = auditDependencies({
    workspaceYaml: bumped,
    lockfileText: realLockfile,
    npmrcText: realNpmrc,
    guideText: realGuide,
  });
  expect(result.failures.join('\n')).toContain(
    'kysely is pinned at 0.30.0, security-guide §11 requires exactly 0.29.3',
  );
});

test('dependency audit FAILS when a forbidden package appears in the lockfile', () => {
  const polluted = `${realLockfile}\n  react-native-reanimated@3.16.1:\n    resolution: { integrity: sha512-x }\n`;
  const result = auditDependencies({
    workspaceYaml: realWorkspace,
    lockfileText: polluted,
    npmrcText: realNpmrc,
    guideText: realGuide,
  });
  expect(result.failures.join('\n')).toContain('react-native-reanimated is in pnpm-lock.yaml');
});

test('dependency audit FAILS when .npmrc drops save-exact', () => {
  const result = auditDependencies({
    workspaceYaml: realWorkspace,
    lockfileText: realLockfile,
    npmrcText: 'engine-strict=true\n',
    guideText: realGuide,
  });
  expect(result.failures.join('\n')).toContain('.npmrc does not set `save-exact=true`');
});

// ── .env.example ────────────────────────────────────────────────────────────────────────────────

test('.env.example parser separates declared names, values, and values on secret-bearing names', () => {
  const parsed = parseEnvExample(
    ['# comment', 'DATABASE_URL=', 'PORT=3000', 'SYSTEM_KEY_DIR='].join('\n'),
  );
  expect(parsed.names).toEqual(['DATABASE_URL', 'PORT', 'SYSTEM_KEY_DIR']);
  expect(parsed.withValues).toEqual(['PORT=3000']);
  expect(parsed.secretsWithValues).toEqual([]);
});

test('.env.example parser FLAGS a value assigned to a secret-bearing name', () => {
  const parsed = parseEnvExample('DATABASE_URL=postgres://u:p@h/db\n');
  expect(parsed.secretsWithValues).toEqual(['DATABASE_URL=postgres://u:p@h/db']);
});

test('the real apps/server/.env.example assigns no value to any secret-bearing name', () => {
  const parsed = parseEnvExample(readFileSync(join(REPO_ROOT, 'apps/server/.env.example'), 'utf8'));
  expect(parsed.names.length).toBeGreaterThan(0);
  expect(parsed.secretsWithValues).toEqual([]);
});
