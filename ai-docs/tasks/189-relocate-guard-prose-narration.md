# TASK 189 — relocate guard-prose narration to a cited incident log; keep the normative rules, cut the essays

**Status:** todo
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.

**Filed by:** the 2026-08-30 complexity/over-engineering audit (owner-approved cut-list, Tier 1 #2).

## Goal

Three prose blocks have grown into essays that **narrate** guards rather than **being** guards. The war stories are valuable *history*, but as per-commit reading they are dead weight. Keep every normative rule; **relocate the narration to one cited incident log** and leave a pointer. Nothing is deleted — it moves and is bound by citation (task 171 pattern).

- **CLAUDE.md §2.11** — 1,148 words, **61% of the file**. Compress to: the rule (*every guard is falsified before it is believed; report the falsification*), the `T-11..T-16` pointer, and a link to the incident log holding the 10+ green-for-wrong-reason war stories.
- **`ai-docs/testing-guide.md` T-11..T-19** — ~15k words. Keep each T-rule's normative one-liner; move the worked narrative to the same incident log.
- **`packages/test-support/src/sec-pending-allowlist.json` `$comment`** — ~600 words / 3,833 chars. Keep the **load-bearing map** (`"SEC-AUTH-10": ".../27-device-gates.md"`) + a one-line reason + a pointer to `decisions/2026-07-22-assume-device-performance-passes.md`. Move the SEC-AUTH-09-discharge and SEC-AUTH-10 narrative to that decision doc (where it already partly lives).

New home: `ai-docs/incidents.md` (or append to an existing log if one fits).

## Must preserve (do NOT cut)

- Every **normative** rule: the falsify-before-believe discipline, T-11..T-16, the allowlist **id→task map** (the JSON key/value that the SEC-META-01 gate actually reads).
- **§2.11 "the comment was the guard" caution:** do **not** touch any inline comment that is the *sole* statement of a platform constraint (e.g. `notifications.ts` Android rule at line 4). This task edits **only** the three named narrative blocks. Leave spec-citing inline comments alone.

## Docs to read

- CLAUDE.md §2.11; `ai-docs/testing-guide.md` T-11..T-19; `packages/test-support/src/sec-pending-allowlist.json`; `ai-docs/decisions/2026-07-22-assume-device-performance-passes.md`.

## Files / modules touched

- CLAUDE.md, `ai-docs/testing-guide.md`, `packages/test-support/src/sec-pending-allowlist.json`, new `ai-docs/incidents.md`.
- **Contended:** CLAUDE.md is read by every agent — serialize; this is its own task. `sec-pending-allowlist.json` is also read by task 192's SEC parser → serialize the test-support SEC area (192 depends on 189).

## Acceptance

- Word counts drop substantially on all three blocks; **zero** normative content is lost — every relocated rule is reachable from its old site by a citation that resolves.
- The SEC-META-01 gate still reads the id→task map unchanged (its input is JSON keys, not the `$comment`).

### Falsification (§2.11)

1. **Bind by citation, assert it resolves** (task 171) — the CLAUDE.md/T-row pointer resolves to the incident log; the allowlist reason resolves to the decision doc. Break a pointer → prove a link-check (or grep) catches the dangling reference.
2. **SEC-META-01 unaffected** — trim the `$comment` to one line, keep the map; re-run the gate → still green because it never read the prose. Then remove the *map entry* → gate reds (proves the load-bearing part was the map, not the essay).
3. No gate changes color from the prose edits (they are documentation); confirm the full gate set is unchanged before/after.
