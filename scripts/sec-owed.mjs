// `pnpm sec:owed` — the NON-REQUIRED companion to the security gate (task 194 / D22). It reports the
// owed-forever SEC red (SEC-AUTH-10) that used to share the `security-sweep` job conclusion with the
// real checks. Its whole job is to be HONESTLY RED while any SEC id is still owed, in its OWN GitHub
// job, so that red is visible without gating a merge (branch protection excludes this job).
//
// It NEVER discharges the red. A green here means the pending allowlist emptied — task 27 landed the
// physical-device argon2id benchmark artifact (D21) — not that the owed check was weakened (§2.11).
//
// It derives the owed set the SAME way the required gate does: `owedIds(guide, allowlist)` over the
// live pending allowlist, using the shared paths. The two jobs therefore can never disagree about
// what is owed (task 184).
import { readFileSync } from 'node:fs';

import {
  SANCTIONED_OWED_IDS,
  SEC_ALLOWLIST_PATH,
  SEC_GUIDE_PATH,
  owedIds,
  pendingAllowlistEntries,
} from './sec-inventory.mjs';

// Fail-closed: an unreadable or malformed guide/allowlist is an ERROR (exit 2), never "nothing is
// owed". A silent empty here would flip the owed job green for the wrong reason — the failure mode
// §2.11 forbids (a guard whose failure mode is "silently checks nothing").
let guideText;
let allowlist;
try {
  guideText = readFileSync(SEC_GUIDE_PATH, 'utf8');
  allowlist = pendingAllowlistEntries(JSON.parse(readFileSync(SEC_ALLOWLIST_PATH, 'utf8')));
} catch (error) {
  console.error(`sec:owed: could not read the SEC inputs — ${error.message}`);
  process.exit(2);
}

const owed = owedIds(guideText, allowlist);
const sanctioned = new Set(SANCTIONED_OWED_IDS);
const unsanctioned = owed.filter((id) => !sanctioned.has(id));

console.log('═══ sec:owed — standing SEC red (non-blocking) ═══');

if (owed.length === 0) {
  console.log(
    'sec:owed: the SEC pending allowlist is EMPTY — nothing is owed. GREEN here means the debt was\n' +
      'discharged (the required gate carries the real checks), not that a check was skipped.',
  );
  process.exit(0);
}

console.log(`owed ids (${SEC_ALLOWLIST_PATH} ∩ the guide): ${owed.join(', ')}`);
console.log(`sanctioned (expected owed): ${[...sanctioned].join(', ') || 'none'}`);
if (unsanctioned.length > 0) {
  // The REQUIRED gate (`pnpm sec:gate`) is what BLOCKS on an unsanctioned owed id; here we only
  // surface it loudly so this job's red is never read as the single sanctioned SEC-AUTH-10 red.
  console.log(
    `WARNING: ${unsanctioned.length} owed id(s) are NOT sanctioned — ${unsanctioned.join(', ')}. ` +
      'The required gate blocks merges while these stand.',
  );
}
console.log(
  '\nsec:owed: RED by design — SEC-AUTH-10 stays owed until task 27 commits the physical-device\n' +
    'argon2id benchmark artifact (D21). This job is excluded from branch-protection required checks.',
);
process.exit(1);
