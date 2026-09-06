# TASK 203 — harness-device driver echoes the result artifact on the SUCCESS path (SEC-AUTH-09 re-anchor harvest)

**Depends on:** —
**Blocks:** the next SEC-AUTH-09 re-anchor (task 27b/160 family) — a green emulator run must be harvestable.
**SEC ids owned by THIS task:** none. Purely additive driver observability; changes no pass/fail decision and touches no AT_REST_SURFACE file, so it does not stale any SEC gate.

## Goal

Make the Android emulator lane's driver (`scripts/harness-device.mjs`) surface the device's exact
`BOLUSI_HARNESS_RESULT` JSON on its **success** path, so a GREEN CI run carries the buildSha-stamped
at-rest artifact in its own job log.

Before this change the driver dumped raw logcat only on the FAILURE path (`dumpFailureDiagnostics`); a
passing run printed a one-line summary and then the emulator — the sole holder of that JSON in its
logcat buffer — was torn down. The artifact a SEC-AUTH-09 re-anchor needs (task 27/160 §3) was therefore
recoverable from every run **except** the green ones that actually produce a valid, buildSha-carrying
one. That is the whole blocker to an autonomous re-anchor: the harvest step as specified ("read the
logcat for the BOLUSI_HARNESS_RESULT JSON") is structurally impossible against a completed green run
without this driver change.

## Deliverable (smallest vertical slice)

- A pure exported `formatResultArtifactLine(rawPayload)` that renders one driver-stdout line re-using
  the device's own `BOLUSI_HARNESS_RESULT:` marker, so the SAME `extractResultPayload` recovers it.
- The success path in `runCli` calls it right before `process.exit(0)`, echoing what the poll already
  parsed (`extractResultPayload(logcatText)`), guarded non-null.
- No change to any gate, verdict, or exit status — success stays success, failure stays failure.

## Docs to read

- `CLAUDE.md` §2.1 (verify ground truth), §2.11 (falsify by construction; never fabricate evidence).
- `testing-guide.md` §2.6 (the on-device harness result document + the `BOLUSI_HARNESS_RESULT` tag).
- Re-anchor mechanism: `packages/harness/src/security/device-gate-provenance.ts` (the SEC-AUTH-09 gate
  that consumes the harvested artifact) + task `160`'s re-land checklist.

## Files / modules touched

- `scripts/harness-device.mjs` — add `formatResultArtifactLine`; call it on the success path.
- `packages/test-support/src/harness-device.test.ts` — round-trip + harvest-usability tests.

Both are the emulator-lane driver and its host-side unit tests; no production/runtime code, no
`@bolusi/*` package surface, no AT_REST_SURFACE file.

## Acceptance

- `extractResultPayload(formatResultArtifactLine(p)) === p` (byte-for-byte round-trip; one parser, no
  second serialization to drift).
- The harvested line JSON-parses back to the exact buildSha it carried (the harvest is USABLE, not
  merely non-empty — a harvest that dropped the buildSha would be a silent no-op, §2.11).
- The payload is recovered even when the echoed line is buried amid other driver stdout (the real
  success path prints a human summary line immediately before it).
- **Falsification (§2.11, watched red):** dropping the marker in `formatResultArtifactLine` makes
  `extractResultPayload` return `null`, reding exactly the three new tests (EXIT=1) while the other 29
  stay green; restoring returns to 32 green.

## Status

Tracked in `_index.md` (§2.6). Flip via `pnpm task:status 203 <status>`.
