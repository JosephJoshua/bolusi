// Falsification harness for the task-07 op-acceptance pipeline (CLAUDE.md §2.11 / testing-guide
// T-11: "a guard is only load-bearing if someone has watched it go red").
//
// Each mutation BREAKS exactly one guard in the shipped pipeline source, runs the tests that are
// supposed to catch it, and asserts they FAIL — then restores the file and (at the end) re-proves
// green. A mutation that leaves the suite green is reported as SURVIVED: that means the guard is
// not actually tested, which is the defect this script exists to find.
//
// Usage: node scripts/falsify-oplog.mjs [--only <name>]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'apps/server/src/oplog';

/** @type {{name:string, file:string, find:string, replace:string, tests:string[], expect:string}[]} */
const MUTATIONS = [
  {
    name: 'signature-gate-disabled',
    file: `${SRC}/steps/signature.ts`,
    find: '  if (digest.hashHex !== claimedHash) return { ok: false };',
    replace: '  if (false && digest.hashHex !== claimedHash) return { ok: false };',
    tests: ['test/integration/oplog/sec-oplog.test.ts', '-t', 'SEC-OPLOG-05'],
    expect: 'BAD_SIGNATURE no longer raised for post-hash mutation',
  },
  {
    name: 'signature-verify-always-true',
    file: `${SRC}/steps/signature.ts`,
    find: '    return crypto.verify(signatureBytes, digest.hash, publicKey)',
    replace: '    return true || crypto.verify(signatureBytes, digest.hash, publicKey)',
    tests: ['test/integration/oplog/sec-oplog.test.ts', '-t', 'SEC-OPLOG-01'],
    expect: 'forged signature accepted',
  },
  {
    name: 'chain-gap-collapsed-into-broken',
    file: `${SRC}/steps/chain.ts`,
    find: "  if (op.seq > expectedSeq) return { kind: 'gap' };",
    replace: "  if (op.seq > expectedSeq) return { kind: 'broken', reason: 'collapsed' };",
    tests: ['test/integration/oplog/sec-oplog.test.ts', '-t', 'SEC-OPLOG-03'],
    expect: 'CHAIN_GAP no longer distinguished from CHAIN_BROKEN',
  },
  {
    name: 'chain-previous-hash-check-disabled',
    file: `${SRC}/steps/chain.ts`,
    find: '  if (op.previousHash !== expectedPrevious) {',
    replace: '  if (false && op.previousHash !== expectedPrevious) {',
    tests: ['test/integration/oplog/sec-oplog.test.ts', '-t', 'SEC-OPLOG-03'],
    expect: 'CHAIN_BROKEN no longer raised for a wrong previousHash',
  },
  {
    name: 'batch-halt-disabled',
    file: `${SRC}/pipeline.ts`,
    find: '        halted = true;',
    replace: '        halted = false;',
    tests: ['test/integration/oplog/pipeline.test.ts', '-t', 'CHAIN_HALTED'],
    expect: 'batch remainder no longer CHAIN_HALTED after a CHAIN_BROKEN',
  },
  {
    name: 'dedupe-disabled',
    file: `${SRC}/steps/dedupe.ts`,
    find: '  return row !== undefined;',
    replace: '  return false;',
    tests: ['test/integration/oplog/sec-oplog.test.ts', '-t', 'SEC-OPLOG-02'],
    expect: 'replay no longer inert (duplicate not returned)',
  },
  {
    name: 'device-binding-disabled',
    file: `${SRC}/pipeline.ts`,
    find: '      if (op.deviceId !== identity.deviceId) {',
    replace: '      if (false && op.deviceId !== identity.deviceId) {',
    tests: ['test/integration/oplog/sec-oplog.test.ts', '-t', 'SEC-OPLOG-04'],
    expect: 'cross-device splice no longer caught by device binding',
  },
  {
    name: 'scope-user-membership-disabled',
    file: `${SRC}/steps/scope.ts`,
    find: "  if (user === undefined) return { reason: 'op userId is not a member of the tenant directory' };",
    replace: "  if (user === undefined && false) return { reason: 'disabled' };",
    tests: [
      'test/integration/oplog/pipeline.test.ts',
      '-t',
      'userId is not in the tenant directory',
    ],
    expect: 'a non-member userId is accepted',
  },
  {
    name: 'pin-reset-main-owner-rule-disabled',
    file: `${SRC}/steps/scope.ts`,
    find: '      if (targetIsMainOwner && !(await userHoldsRole(db, op.userId, MAIN_OWNER_ROLE))) {',
    replace: '      if (false && targetIsMainOwner) {',
    tests: [
      'test/integration/oplog/pipeline.test.ts',
      '-t',
      'main_owner by a non-main_owner actor',
    ],
    expect: 'store_owner can reset a main_owner PIN (privilege escalation)',
  },
  {
    name: 'skew-flag-disabled',
    file: `${SRC}/skew.ts`,
    find: '  return Math.abs(timestamp - receivedAt) > threshold;',
    replace: '  return false;',
    tests: ['test/integration/oplog/sec-oplog.test.ts', '-t', 'SEC-OPLOG-08'],
    expect: 'clock skew no longer flagged',
  },
  {
    name: 'skew-rejects-instead-of-flags',
    file: `${SRC}/skew.ts`,
    find: '  return Math.abs(timestamp - receivedAt) > threshold;',
    replace: '  return Math.abs(timestamp - receivedAt) >= 0;',
    tests: ['src/oplog/skew.test.ts'],
    expect: 'skew boundary no longer honoured (everything flagged)',
  },
  {
    name: 'anomaly-recording-disabled',
    file: `${SRC}/anomalies.ts`,
    find: "  await db\n    .insertInto('deviceAnomalies')",
    replace: "  if (input) return;\n  await db\n    .insertInto('deviceAnomalies')",
    tests: ['test/integration/oplog/anomalies.test.ts'],
    expect: 'tamper alarms (FR-829) no longer recorded',
  },
  {
    name: 'serverseq-lock-removed',
    file: `${SRC}/server-seq.ts`,
    find: '    .forUpdate()\n',
    replace: '',
    tests: ['test/integration/oplog/server-seq.test.ts', '-t', 'FOR UPDATE'],
    expect: 'the counter row is no longer locked at transaction start',
  },
];

function run(args) {
  try {
    const out = execFileSync('pnpm', ['exec', 'vitest', 'run', '--project', 'server', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15 * 60 * 1000,
    });
    return { exit: 0, out };
  } catch (error) {
    return { exit: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : undefined;

const results = [];
for (const m of MUTATIONS) {
  if (only && m.name !== only) continue;
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.find)) {
    results.push({ name: m.name, verdict: 'ANCHOR-MISSING', detail: m.find.slice(0, 60) });
    continue;
  }
  writeFileSync(m.file, original.replace(m.find, m.replace));
  const { exit, out } = run(m.tests);
  writeFileSync(m.file, original); // restore ALWAYS
  const failed = /Tests\s+\d+ failed/.test(out) || exit !== 0;
  results.push({
    name: m.name,
    verdict: failed ? 'CAUGHT' : 'SURVIVED (guard not load-bearing!)',
    expect: m.expect,
    line: (out.match(/Tests\s+.*/) ?? [''])[0].trim(),
  });
  console.log(`${failed ? 'CAUGHT   ' : 'SURVIVED '} ${m.name} — ${m.expect}`);
}

console.log('\n=== FALSIFICATION SUMMARY ===');
for (const r of results)
  console.log(`${r.verdict.padEnd(34)} ${r.name}  ${r.line ?? r.detail ?? ''}`);
const bad = results.filter((r) => r.verdict !== 'CAUGHT');
console.log(`\n${results.length - bad.length}/${results.length} mutations caught`);
process.exit(bad.length === 0 ? 0 : 1);
