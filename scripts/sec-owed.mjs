// `pnpm sec:owed` — the OWED SEC ids, and nothing else (task 194).
//
// WHY THIS EXISTS AS ITS OWN COMMAND AND ITS OWN CI JOB
// ----------------------------------------------------
// SEC-AUTH-10 is owed until a physical device produces its KDF benchmark artifact (D21). That red
// is permanent and CORRECT. For most of v0 it shared the `security-sweep` job conclusion with the
// real security checks, so one red meant either "the expected one" or "a regression" — and telling
// them apart needed a tower of CI-log-parsing oracles (scripts/ci-parity.mjs + ci-status.mjs, ~2.2k
// LOC, deleted by task 194) and a five-task patch chain (142 → 154 → 166 → 172 → 184), each fixing
// the previous wrapper's blindness.
//
// The fix is structural, not another wrapper: the owed check lives in its OWN job, so the job
// identity IS the classification. `security-sweep` fails only on real findings and blocks merges;
// this job fails only while ids are owed and does not block. Nothing downstream has to re-derive
// which red is which, because the two reds are no longer the same signal.
//
// AN HONEST RED IS A CORRECT RESULT. This command is EXPECTED to exit 1 while any id is owed. It
// retires when task 27 lands the device artifact and the allowlist empties — never by editing the
// allowlist to make the red go away, which would be moving the yardstick (CLAUDE.md §2.11).
import { readFileSync } from 'node:fs';

import { pendingOwedIds } from './sec-inventory.mjs';

const [
  guidePath = 'ai-docs/security-guide.md',
  allowlistPath = 'packages/test-support/src/sec-pending-allowlist.json',
] = process.argv.slice(2);

const rawAllowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
const owed = pendingOwedIds({
  guideText: readFileSync(guidePath, 'utf8'),
  // `$`-prefixed keys are schema/comment rows in the allowlist file, not SEC ids.
  allowlist: Object.fromEntries(
    Object.entries(rawAllowlist).filter(([key]) => !key.startsWith('$')),
  ),
});

if (owed.length === 0) {
  console.log('sec:owed: the pending allowlist is EMPTY — no SEC id is owed. EXIT=0');
  process.exit(0);
}

console.error(
  `sec:owed: ${owed.length} SEC id(s) owed — this job is EXPECTED red and does NOT block merges.`,
);
for (const { id, owner } of owed) console.error(`sec:owed:   ${id} → owed by ${owner}`);
console.error(
  'sec:owed: each retires only when its owning task produces the required artifact. Do NOT empty\n' +
    'sec:owed: the allowlist to green this job — that discharges the id without the proof (§2.11).',
);
process.exit(1);
