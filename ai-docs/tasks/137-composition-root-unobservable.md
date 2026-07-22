# TASK 137 — the composition root is structurally unguarded (one test mounts `Root`, with substituted factories) and the knip gate cannot see unused FILES

**Status:** in-progress
**Priority:** MEDIUM — this is the **cause** of tasks 122/133/134/135/136, not another instance of them. Both halves are guard blindness: nothing observes production wiring, and the sweep that exists to catch dead code has dead files outside its denominator.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA test-honesty sweep, 2026-07-22.

## Half A — `Root.tsx`'s wiring decisions are unobservable

`apps/mobile/test/live-shell-support.tsx`'s `mountRoot` is the **sole** `<Root>` render in the repo. It passes **no** `createSync`, **no** `createMedia`, and a `createNotes` that takes 3 parameters and hardcodes `media: UNWIRED_NOTES_MEDIA` — production's takes 4 and calls `notesMediaSeamsFor(media)`. Demonstrated consequences (both reverted):

- **Media→notes binding.** `Root.tsx:164-176`'s own comment cites §2.11 and predicts *"the honest answer to 'if this binding were wrong, what would notice?' would be 'nothing'"*. Passing `null` instead of `media` and dropping `media` from the effect deps → **62/62 files, 569/569 tests, EXIT=0**. The comment's prediction is correct.
- **Permission bootstrap.** Deleting `await enroll.evaluator.prime()` (02-permissions §6) **and** the `onBundleRefresh` memo-invalidation argument (§6 (a)) → **62/62, 569/569, EXIT=0**.

`apps/mobile/index.ts` has no test importing it at all (task 136 corrupted its production binding to throw → zero failures).

**Deliverable A:** a composed harness that mounts `Root` with the **production** factories over fake PORTS (the platform-free-core design exists for exactly this — the web visual harness already does it). Every wiring decision above must have a test that reds when the decision is broken. Report each falsification individually.

## Half B — `pnpm knip` reads unused EXPORTS and never unused FILES

`scripts/check-unused-exports.mjs:79-83` iterates `issue.exports` only; `issue.files` is never read, and `KNIP_ARGS` is `--production --include exports`. knip classifies a file unreachable from the entry as a **file** issue with `exports: []`, so its symbols are never enumerated. Result: `pnpm knip` → `119 unused exports (baseline 119) … sweep is not blind` / `EXIT=0` while `grep -c "push/registration\|push/routes\|shell-session\|user-workspaces" knip-baseline.json` → **0**. The dead files behind 133/135 are invisible to the gate that exists to catch them — a guard whose failure mode is "silently checks nothing" (§2.11).

Running knip *without* `--include exports` lists them plainly: `push/registration.ts`, `push/routes.ts`, `session/shell-session.ts`, `state/user-workspaces.ts`.

**Deliverable B:** extend the gate to read `issue.files` with its own baseline, so an unreachable production file fails the sweep the way an unused export does. **`apps/server`'s file list from that run is noise** — its configured entries (`src/index.ts`/`main.ts`) don't match how knip resolves that workspace, so everything shows unused; fix the server entry config first or the new gate will be all-red and get muted, which is the worse failure. `apps/mobile`'s resolution is sound (`src/i18n.ts` is correctly not listed) — verify that before believing any list.

## FALSIFY (§2.11 — REPORT it)
- Half A: for each guarded decision, break it → the new composed test reds; restore → green. A harness that passes against a blank mount proves nothing (T-14: assert real content).
- Half B: add a throwaway unreachable production file → the file gate reds and names it; delete it → green. And confirm the export half still reds on a new unused export (don't trade one blindness for another).


---

## Half B: DONE 2026-07-22 (commit `d020f1a`, pending review). Half A still open — that is why this task stays open.

What the implementer established, and what it changed beyond the stated scope:

- **The knip JSON shape** (knip 6.27.0, read from its own output): one record per file; `--include` gates which keys exist. With `--include exports` there is **no `files` key at all**. The `files` and `exports` finding sets are **disjoint — 0 files appear in both**, so the old lane could not have seen an unreachable file under any baseline. Adding `files` to `--include` leaves the export set byte-identical (123 == 123), so one process serves both halves.
- **The `apps/server` entry bug was not a path problem — it was production-mode semantics.** knip's `--production` lane uses **only** entry patterns suffixed `!`, and a config `entry` array replaces the defaults entirely. `apps/server`'s entries had no `!`, so that workspace had *no entry at all* in the production lane → 78 of 82 `src` files reported unused. (`packages/test-support` already used `!`, which is why its canary worked.) Four `!` suffixes fixed it: server file findings 158 → 93, `apps/server/src` 78 → 13.
- **That un-blinded the EXPORT half too:** **+4** previously-invisible unused exports appeared in `apps/server/src/middleware/auth.ts` (`CONTROL_TOKEN_PREFIX`, `DEVICE_TOKEN_PREFIX`, `InMemoryTokenStore`, `emptyTokenStore`), with **0 lost**. Export baseline 119 → 123. So the export sweep had a hole of its own the whole time, in the auth middleware.
- **Category partitioning, fail-closed.** Of 197 raw production-lane file findings, 158 are category artifacts (tests, scripts, migrations, configs — unreachable from a production entry *by definition*); baselining those would red the gate on every task that adds a test, which is the muting outcome. Only the 39-file production remainder is enforced, and a path is excluded **only if it matches a named rule**, so an unanticipated file class is enforced loudly rather than dropped silently.
- **A deliberate refusal worth keeping:** the excluded count is build-state dependent (158 → 84 after `tsc -b`) while the enforced set is not (39, +0/-0 either way). CI runs knip with no build, so the implementer refused to freeze the excluded count in the baseline — "a stable-looking number with unstable provenance". Rule *names* are recorded instead.

### Two findings this surfaced, for the next sweep (not defects of this task)
1. **The entire `apps/server/src/push/*` module is dead in production** — `expo-sender`, `fanout`, `payload`, `port`, `receipts`, 5 files. This is **independent corroboration of task 134**, arrived at by a different instrument (semantic reachability, not grep).
2. **`packages/modules/src/notes/screens/*` (7 files) plus `notes/{index,media-ref,conflict-checks}.ts` report as unreachable.** These screens demonstrably DO render (task 119 wired them; the visual harness screenshots them), so this is most likely knip being unable to follow the module registry's dynamic resolution — a false-positive class, not dead code. **Confirm which before acting**, and if it is the registry, record that so nobody later "cleans up" a live screen on the strength of this baseline.
