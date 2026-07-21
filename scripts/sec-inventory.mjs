// The SEC inventory (task 28; security-guide §2.1.4, §12) — the release gate's first assertion.
//
// SEC-META-01 (packages/test-support/src/sec-meta.test.ts) already proves every SEC id has a
// verbatim test TITLE or an allowlist row. That is presence. This adds the two things presence
// cannot give you:
//
//   1. **The §12 roll-up is the denominator.** The guide's own roll-up line names the id ranges the
//      suite is supposed to contain. Parsing the body for ids and comparing the two sets makes doc
//      drift fail: an id added to a surface table but never rolled up, or rolled up but deleted
//      from its table, is a silent hole in a gate whose whole job is "no missing id". (It fired the
//      moment it was written — see the drift note in the sweep's output.)
//   2. **Passes, not presence.** A title proves a test was written; it says nothing about whether
//      the test RAN or PASSED. This reads the vitest JSON reports of the lanes the sweep executes
//      and requires each id to have at least one test whose status is `passed`. A SEC-titled test
//      that fails, is skipped, or whose lane never ran, fails the inventory.
//
// Kept as pure functions with a thin CLI so the negative controls can be unit-tested against
// fixtures (packages/test-support/src/sec-inventory.test.ts) rather than by breaking the repo.
import { readFileSync } from 'node:fs';

export const SEC_ID_PATTERN = /SEC-[A-Z]+-[0-9]+/g;

/** Every SEC id mentioned anywhere in the guide, sorted and deduped. */
export function parseGuideIds(guideText) {
  return [...new Set(guideText.match(SEC_ID_PATTERN) ?? [])].sort();
}

/**
 * Expand the §12 roll-up line ("Roll-up: OPLOG 01–09 · SYNC 01–10 · … · META 01.") into the id set
 * it declares. Ranges use an EN DASH in the doc; a plain hyphen and an em dash are accepted too so
 * a typographic edit does not silently shrink the denominator.
 *
 * Returns `{ ids, entries }`. An EMPTY result means the parse matched nothing — callers must fail
 * loudly rather than treat "no expected ids" as "nothing to check" (testing-guide T-14).
 */
export function parseRollupIds(guideText) {
  const line = guideText.match(/Roll-up:\s*([^\n]*)/);
  if (line === null) return { ids: [], entries: [] };
  const ids = [];
  const entries = [];
  for (const part of line[1].split('·')) {
    const matched = part.match(/^\s*([A-Z]+)\s+(\d+)(?:\s*[–—-]\s*(\d+))?/);
    if (matched === null) continue;
    const [, area, startRaw, endRaw] = matched;
    const width = startRaw.length;
    const start = Number(startRaw);
    const end = endRaw === undefined ? start : Number(endRaw);
    if (end < start) continue;
    entries.push(endRaw === undefined ? `${area} ${startRaw}` : `${area} ${startRaw}-${endRaw}`);
    for (let n = start; n <= end; n += 1) {
      ids.push(`SEC-${area}-${String(n).padStart(width, '0')}`);
    }
  }
  return { ids: [...new Set(ids)].sort(), entries };
}

/**
 * Fold vitest JSON reports into `id -> { passed, failed, other, titles }`.
 *
 * Matching is on `fullName` (describe ancestry + leaf title), mirroring SEC-META-01's rule that a
 * `describe`'s first string argument is a title claim: an id claimed on the describe is credited
 * only when a test underneath it actually passed.
 *
 * @param {Array<{lane: string, report: unknown}>} reports
 * @param {readonly string[]} requiredIds
 */
export function secOutcomes(reports, requiredIds) {
  const outcomes = new Map(
    requiredIds.map((id) => [id, { passed: 0, failed: 0, other: 0, titles: [] }]),
  );
  let assertions = 0;
  for (const { lane, report } of reports) {
    for (const file of report?.testResults ?? []) {
      for (const assertion of file?.assertionResults ?? []) {
        assertions += 1;
        const fullName = String(assertion.fullName ?? '');
        for (const id of requiredIds) {
          if (!fullName.includes(id)) continue;
          const entry = outcomes.get(id);
          if (assertion.status === 'passed') entry.passed += 1;
          else if (assertion.status === 'failed') entry.failed += 1;
          else entry.other += 1;
          entry.titles.push(`[${lane}] ${assertion.status}: ${fullName}`);
        }
      }
    }
  }
  return { outcomes, assertions };
}

/**
 * The whole inventory verdict.
 *
 * @param {{ guideText: string, allowlist: Record<string,string>, reports: Array<{lane: string, report: unknown}> }} input
 */
export function auditInventory(input) {
  const failures = [];
  const guideIds = parseGuideIds(input.guideText);
  const rollup = parseRollupIds(input.guideText);

  // ── denominator guards: the inventory must never check nothing ────────────────────────────────
  if (guideIds.length === 0) {
    failures.push(
      'parsed ZERO SEC ids out of security-guide.md — the parse is broken, not the doc',
    );
  }
  if (rollup.ids.length === 0) {
    failures.push(
      'parsed ZERO ids out of the §12 "Roll-up:" line — the roll-up is missing or its grammar changed',
    );
  }

  // ── the §12 roll-up must equal the ids the doc actually defines ───────────────────────────────
  const rollupSet = new Set(rollup.ids);
  const guideSet = new Set(guideIds);
  const notInRollup = guideIds.filter((id) => !rollupSet.has(id));
  const notInGuide = rollup.ids.filter((id) => !guideSet.has(id));
  for (const id of notInRollup) {
    failures.push(
      `${id} appears in security-guide.md but NOT in the §12 roll-up — the roll-up is the sweep's declared denominator and must name every id`,
    );
  }
  for (const id of notInGuide) {
    failures.push(
      `${id} is declared by the §12 roll-up but appears nowhere else in security-guide.md — a rolled-up id with no surface table`,
    );
  }

  // ── pass status, per id ───────────────────────────────────────────────────────────────────────
  const { outcomes, assertions } = secOutcomes(input.reports, guideIds);
  if (assertions === 0) {
    failures.push(
      'the vitest reports contained ZERO assertions — the lanes did not run, so every "passed" below would be vacuous',
    );
  }
  const pending = [];
  for (const id of guideIds) {
    const owner = input.allowlist[id];
    const outcome = outcomes.get(id);
    if (owner !== undefined) {
      pending.push(`${id} → ${owner}`);
      if (outcome.passed + outcome.failed + outcome.other > 0) {
        failures.push(
          `${id} is on the pending allowlist (owed by ${owner}) but a test titles it — the row and the title cannot both be true`,
        );
      }
      continue;
    }
    if (outcome.failed > 0 || (outcome.passed === 0 && outcome.other > 0)) {
      failures.push(`${id} has a SEC-titled test that did not pass: ${outcome.titles.join(' | ')}`);
      continue;
    }
    if (outcome.passed === 0) {
      failures.push(
        `${id} has no PASSING test in any swept lane (titles seen: ${outcome.titles.length === 0 ? 'none' : outcome.titles.join(' | ')})`,
      );
    }
  }

  // ── the allowlist must be empty for a release (task 28's contract) ────────────────────────────
  if (pending.length > 0) {
    failures.push(
      `the SEC pending allowlist is NOT empty — the release gate cannot pass while ids are owed: ${pending.join(', ')}`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    pending,
    checked: {
      guideIds: guideIds.length,
      rollupIds: rollup.ids.length,
      rollupEntries: rollup.entries,
      assertions,
      idsWithPass: guideIds.filter((id) => outcomes.get(id).passed > 0).length,
    },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [
    guidePath = 'ai-docs/security-guide.md',
    allowlistPath = 'packages/test-support/src/sec-pending-allowlist.json',
    ...reportPaths
  ] = process.argv.slice(2);
  const rawAllowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  const allowlist = Object.fromEntries(
    Object.entries(rawAllowlist).filter(([key]) => !key.startsWith('$')),
  );
  const reports = reportPaths.map((path) => ({
    lane: path,
    report: JSON.parse(readFileSync(path, 'utf8')),
  }));
  const result = auditInventory({
    guideText: readFileSync(guidePath, 'utf8'),
    allowlist,
    reports,
  });
  console.log(
    `sec-inventory: ${result.checked.guideIds} ids parsed from the guide, ` +
      `${result.checked.rollupIds} declared by the §12 roll-up (${result.checked.rollupEntries.join(' · ')}), ` +
      `${result.checked.assertions} test assertions read from ${reports.length} lane report(s), ` +
      `${result.checked.idsWithPass} ids with >=1 PASSING test.`,
  );
  for (const failure of result.failures) console.error(`sec-inventory: FAIL ${failure}`);
  process.exit(result.ok ? 0 : 1);
}
