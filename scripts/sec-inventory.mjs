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

/**
 * Machine-readable failure codes (task 166). Every FAIL string an inventory produces begins with
 * exactly one `[CODE]` token, so the downstream reader — `classifyInventoryForGate` below, which the
 * required `pnpm sec:gate` job runs — can scope the gate's owed-red exemption by FAILURE MODE, not
 * merely by which id a FAIL line names. Only PENDING_ALLOWLIST_NON_EMPTY is owed-eligible: a DIFFERENT
 * mode that happens to name an owed id (e.g. an id that is BOTH allowlisted AND titled — a real
 * bookkeeping regression) must surface as UNEXPECTED rather than be absorbed by the standing SEC red.
 * Keep these tokens stable and unique; `classifyInventoryForGate` matches on
 * PENDING_ALLOWLIST_NON_EMPTY, and any other code is a real (blocking) failure.
 */
export const SEC_FAIL_CODES = Object.freeze({
  ZERO_GUIDE_IDS: 'ZERO_GUIDE_IDS',
  ZERO_ROLLUP_IDS: 'ZERO_ROLLUP_IDS',
  ROLLUP_MISSING_ID: 'ROLLUP_MISSING_ID',
  ROLLUP_EXTRA_ID: 'ROLLUP_EXTRA_ID',
  ZERO_ASSERTIONS: 'ZERO_ASSERTIONS',
  ALLOWLISTED_BUT_TITLED: 'ALLOWLISTED_BUT_TITLED',
  TEST_NOT_PASSING: 'TEST_NOT_PASSING',
  NO_PASSING_TEST: 'NO_PASSING_TEST',
  PENDING_ALLOWLIST_NON_EMPTY: 'PENDING_ALLOWLIST_NON_EMPTY',
});

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
      `[${SEC_FAIL_CODES.ZERO_GUIDE_IDS}] parsed ZERO SEC ids out of security-guide.md — the parse is broken, not the doc`,
    );
  }
  if (rollup.ids.length === 0) {
    failures.push(
      `[${SEC_FAIL_CODES.ZERO_ROLLUP_IDS}] parsed ZERO ids out of the §12 "Roll-up:" line — the roll-up is missing or its grammar changed`,
    );
  }

  // ── the §12 roll-up must equal the ids the doc actually defines ───────────────────────────────
  const rollupSet = new Set(rollup.ids);
  const guideSet = new Set(guideIds);
  const notInRollup = guideIds.filter((id) => !rollupSet.has(id));
  const notInGuide = rollup.ids.filter((id) => !guideSet.has(id));
  for (const id of notInRollup) {
    failures.push(
      `[${SEC_FAIL_CODES.ROLLUP_MISSING_ID}] ${id} appears in security-guide.md but NOT in the §12 roll-up — the roll-up is the sweep's declared denominator and must name every id`,
    );
  }
  for (const id of notInGuide) {
    failures.push(
      `[${SEC_FAIL_CODES.ROLLUP_EXTRA_ID}] ${id} is declared by the §12 roll-up but appears nowhere else in security-guide.md — a rolled-up id with no surface table`,
    );
  }

  // ── pass status, per id ───────────────────────────────────────────────────────────────────────
  const { outcomes, assertions } = secOutcomes(input.reports, guideIds);
  if (assertions === 0) {
    failures.push(
      `[${SEC_FAIL_CODES.ZERO_ASSERTIONS}] the vitest reports contained ZERO assertions — the lanes did not run, so every "passed" below would be vacuous`,
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
          `[${SEC_FAIL_CODES.ALLOWLISTED_BUT_TITLED}] ${id} is on the pending allowlist (owed by ${owner}) but a test titles it — the row and the title cannot both be true`,
        );
      }
      continue;
    }
    if (outcome.failed > 0 || (outcome.passed === 0 && outcome.other > 0)) {
      failures.push(
        `[${SEC_FAIL_CODES.TEST_NOT_PASSING}] ${id} has a SEC-titled test that did not pass: ${outcome.titles.join(' | ')}`,
      );
      continue;
    }
    if (outcome.passed === 0) {
      failures.push(
        `[${SEC_FAIL_CODES.NO_PASSING_TEST}] ${id} has no PASSING test in any swept lane (titles seen: ${outcome.titles.length === 0 ? 'none' : outcome.titles.join(' | ')})`,
      );
    }
  }

  // ── the allowlist must be empty for a release (task 28's contract) ────────────────────────────
  if (pending.length > 0) {
    failures.push(
      `[${SEC_FAIL_CODES.PENDING_ALLOWLIST_NON_EMPTY}] the SEC pending allowlist is NOT empty — the release gate cannot pass while ids are owed: ${pending.join(', ')}`,
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

/**
 * The sanctioned standing SEC red (D21 / D22). SEC-AUTH-10 is owed until task 27 commits the
 * physical-device argon2id-p95 timing artifact; the assumption produces NO artifact, so it is
 * allowlist-pending rather than a discharged test. It is the ONLY id whose owed red is expected.
 *
 * This constant is the native successor to the hand-tended owed exemption ci-parity.mjs carried
 * (tasks 166/172/184): a discharge simply removes SEC-AUTH-10 from the pending allowlist, at which
 * point `owedIds()` returns [] and `classifyInventoryForGate` is vacuously satisfied — nothing here
 * is hand-edited to follow the allowlist.
 */
export const SANCTIONED_OWED_IDS = Object.freeze(['SEC-AUTH-10']);

/**
 * The ids the pending allowlist still owes: allowlist keys the guide actually defines. Pure — it
 * needs no test reports, because it is exactly the set `auditInventory()` folds into `result.pending`
 * (an id is pending iff it is a guide id with an allowlist row). Both the required gate (via the
 * result's `pending`) and the non-required owed reporter derive the owed set from HERE, so there is
 * ONE source (task 184), never a hand-copied list that can drift from the allowlist.
 *
 * @param {string} guideText
 * @param {Record<string,string>} allowlist  keys already stripped of `$`-prefixed doc metadata
 * @returns {string[]} the owed ids, sorted
 */
export function owedIds(guideText, allowlist) {
  const guide = new Set(parseGuideIds(guideText));
  return Object.keys(allowlist)
    .filter((id) => guide.has(id))
    .sort();
}

/**
 * Split an `auditInventory()` result into the sanctioned standing red and everything a REQUIRED
 * merge gate must block on. This is the in-process successor to ci-parity.mjs's SEC_OWED_D21
 * CI-LOG assertion (D22): it reads the STRUCTURED result — `failures` (each `[CODE] …`) and
 * `pending` (`<id> → <owner>`) — never a job's printed log, and it preserves the three orthogonal
 * scopes the 166/172/184 patch chain forced. All three must hold for the owed red to be tolerated:
 *
 *   1. FAILURE-MODE scope (task 166): only `[PENDING_ALLOWLIST_NON_EMPTY]` is owed-eligible. Any
 *      other SEC_FAIL_CODE — even one that NAMES an owed id, e.g. SEC-AUTH-10 both allowlisted AND
 *      titled → `[ALLOWLISTED_BUT_TITLED]`, a real bookkeeping regression — stays real and blocks.
 *   2. ID scope (task 184): the owed ids must be a SUBSET of the sanctioned set. A second owed id
 *      (a stranger added to the allowlist) is NOT absorbed — it reds the gate. The owed set is read
 *      from `result.pending`, never a hand-copied literal.
 *   3. STEP scope (task 154): this classifies the INVENTORY result only. The gate RUNNER blocks on
 *      any red from the other steps (build, lanes, secrets, deps, lockfile) unconditionally — those
 *      never reach this function, so no non-inventory red can be mislabelled owed.
 *
 * @param {{ failures: readonly string[], pending: readonly string[] }} result  an `auditInventory()` return
 * @param {readonly string[]} [sanctioned]  the ids whose owed red is expected (defaults to SANCTIONED_OWED_IDS)
 * @returns {{ ok: boolean, realFailures: string[], owedFailures: string[], owedIds: string[], unsanctionedOwedIds: string[] }}
 */
export function classifyInventoryForGate(result, sanctioned = SANCTIONED_OWED_IDS) {
  const sanctionedSet = new Set(sanctioned);
  const owedToken = `[${SEC_FAIL_CODES.PENDING_ALLOWLIST_NON_EMPTY}]`;
  const realFailures = [];
  const owedFailures = [];
  for (const failure of result.failures) {
    // FAILURE-MODE scope: a FAIL line is owed-eligible ONLY when its leading `[CODE]` is the pending
    // one. Every other code — including one that names SEC-AUTH-10 — is a real, blocking regression.
    if (failure.startsWith(owedToken)) owedFailures.push(failure);
    else realFailures.push(failure);
  }
  // ID scope: read the owed ids from the structured pending entries (`<id> → <owner>`), taking the id
  // from BEFORE the arrow so an owner path can never contribute a stray id. Not a re-parse of prose.
  const owed = result.pending
    .map((entry) => String(entry).split('→')[0].match(SEC_ID_PATTERN)?.[0])
    .filter((id) => id !== undefined);
  const unsanctionedOwedIds = owed.filter((id) => !sanctionedSet.has(id));
  return {
    // The required gate is green IFF nothing real is red AND every owed id is sanctioned. A discharge
    // (empty allowlist → owed = []) is vacuously ok; a stranger owed id or any real code blocks.
    ok: realFailures.length === 0 && unsanctionedOwedIds.length === 0,
    realFailures,
    owedFailures,
    owedIds: owed,
    unsanctionedOwedIds,
  };
}

/**
 * The two files every SEC entry point reads. Exported so the required gate and the non-required owed
 * reporter (task 194) compute the owed set from the SAME inputs — a drift here would let the two jobs
 * disagree about what is owed (task 184), the exact hazard the split exists to remove.
 */
export const SEC_GUIDE_PATH = 'ai-docs/security-guide.md';
export const SEC_ALLOWLIST_PATH = 'packages/test-support/src/sec-pending-allowlist.json';

/**
 * Drop the `$`-prefixed documentation keys from a raw pending-allowlist object, leaving only owed ids.
 * The allowlist stores its own prose under `$comment`-style keys; every reader must strip them the
 * same way or the owed set silently gains a non-id member.
 *
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, string>}
 */
export function pendingAllowlistEntries(raw) {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('$')));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [guidePath = SEC_GUIDE_PATH, allowlistPath = SEC_ALLOWLIST_PATH, ...reportPaths] =
    process.argv.slice(2);
  const allowlist = pendingAllowlistEntries(JSON.parse(readFileSync(allowlistPath, 'utf8')));
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
