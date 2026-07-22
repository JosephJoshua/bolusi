// Positive control for the knip unused-FILE sweep (task 137; CLAUDE.md §2.11 / testing-guide T-14).
//
// The sibling `knip-canary.ts` is the control for the unused-EXPORT half: it is a knip `entry`,
// so it is always REACHABLE and its export is always reported. That makes it structurally unable
// to prove anything about the file half — knip reports a file issue only for files it cannot
// reach, and it never enumerates the exports of such a file (verified against knip 6.27.0's own
// JSON: the `files` and `exports` finding sets are disjoint). That disjointness is the exact
// defect task 137 fixes; the export canary was green throughout it.
//
// So this file is the file half's denominator. It is deliberately NOT registered as an entry in
// knip.json, and NOTHING imports it, so `knip --production --include files` MUST report it as an
// unused file on every run. `scripts/check-unused-exports.mjs` asserts it appears in the ENFORCED
// partition of the file findings and FAILS LOUDLY if it does not. What that catches:
//
//   - `--include files` dropped from KNIP_ARGS, or `issue.files` stopped being read  → gone.
//   - knip's JSON shape changes (`files: [{ name }]`)                                → gone.
//   - entry/project globs break so knip scans a fraction of the tree                 → gone.
//   - an exclusion rule widened over THIS file's directory                           → gone.
//
// And what it does NOT catch, stated because the first version of this comment claimed otherwise
// and the review of task 137 disproved it: an exclusion rule widened over some OTHER directory.
// `migrations-dir` swallowed four live `packages/db-client/src/migrations/**` files while this
// canary sat here present and green. A canary is one file at one path; it cannot speak for paths
// it does not occupy. That class is closed by the `src/` invariant in classify() — by
// construction — not by this file. Do not read a present canary as "the partition is sound".
//
// DO NOT import this symbol, reference it from a test, delete it, or "clean it up". This file is
// unreachable BY DESIGN. If knip stops reporting it, the sweep is broken — fix the sweep, not
// this file.
export const KNIP_FILE_SWEEP_CANARY =
  'knip unused-file positive control — see scripts/check-unused-exports.mjs (task 137)' as const;
