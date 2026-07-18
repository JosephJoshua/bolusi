// Positive control for the knip export sweep (task 68; CLAUDE.md §2.11 / testing-guide T-14).
//
// This file exists ONLY to be reported by `pnpm knip`. It is registered as a knip `entry`
// for this workspace (knip.json) and exports one symbol that NOTHING imports — so the sweep,
// configured with `includeEntryExports: true`, MUST list it as an unused export on every run.
//
// `scripts/check-unused-exports.mjs` asserts this symbol appears in knip's output and FAILS
// LOUDLY if it does not. That is the denominator (T-14): the two ways task 60 watched this
// sweep go blind — dropping `includeEntryExports` (entry-file exports vanish) or breaking the
// entry/project globs (knip scans nothing) — both make THIS symbol disappear first. A green
// sweep that can no longer see its own canary is checking nothing, and the gate turns red
// instead of reporting a confident, useless zero.
//
// DO NOT import this symbol, reference it from a test, delete it, or "clean it up". It is dead
// BY DESIGN. If knip stops reporting it, the sweep is broken — fix the sweep, not this file.
export const KNIP_SWEEP_CANARY =
  'knip positive control — see scripts/check-unused-exports.mjs (task 68)' as const;
