# TASK 137 — the composition root is structurally unguarded (one test mounts `Root`, with substituted factories) and the knip gate cannot see unused FILES

**Status:** done
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

## Half B: DONE 2026-07-22 (commit `d020f1a`, **rejected in review**; fixes follow below). Half A still open — that is why this task stays open.

What the implementer established, and what it changed beyond the stated scope:

- **The knip JSON shape** (knip 6.27.0, read from its own output): one record per file; `--include` gates which keys exist. With `--include exports` there is **no `files` key at all**. The `files` and `exports` finding sets are **disjoint — 0 files appear in both**, so the old lane could not have seen an unreachable file under any baseline. Adding `files` to `--include` leaves the export set byte-identical (123 == 123), so one process serves both halves.
- **The `apps/server` entry bug was not a path problem — it was production-mode semantics.** knip's `--production` lane uses **only** entry patterns suffixed `!`, and a config `entry` array replaces the defaults entirely. `apps/server`'s entries had no `!`, so that workspace had *no entry at all* in the production lane → 78 of 82 `src` files reported unused. (`packages/test-support` already used `!`, which is why its canary worked.) Four `!` suffixes fixed it: server file findings 158 → 93, `apps/server/src` 78 → 13.
- **That un-blinded the EXPORT half too:** **+4** previously-invisible unused exports appeared in `apps/server/src/middleware/auth.ts` (`CONTROL_TOKEN_PREFIX`, `DEVICE_TOKEN_PREFIX`, `InMemoryTokenStore`, `emptyTokenStore`), with **0 lost**. Export baseline 119 → 123. So the export sweep had a hole of its own the whole time, in the auth middleware.
- **Category partitioning, fail-closed.** Of 197 raw production-lane file findings, 158 are category artifacts (tests, scripts, migrations, configs — unreachable from a production entry *by definition*); baselining those would red the gate on every task that adds a test, which is the muting outcome. Only the 39-file production remainder is enforced, and a path is excluded **only if it matches a named rule**, so an unanticipated file class is enforced loudly rather than dropped silently.
- **A deliberate refusal worth keeping:** the excluded count is build-state dependent (158 → 84 after `tsc -b`) while the enforced set is not (39, +0/-0 either way). CI runs knip with no build, so the implementer refused to freeze the excluded count in the baseline — "a stable-looking number with unstable provenance". Rule *names* are recorded instead.

### Two findings this surfaced, for the next sweep (not defects of this task)
1. **The entire `apps/server/src/push/*` module is dead in production** — `expo-sender`, `fanout`, `payload`, `port`, `receipts`, 5 files. This is **independent corroboration of task 134**, arrived at by a different instrument (semantic reachability, not grep).
2. ~~**`packages/modules/src/notes/screens/*` (7 files) plus `notes/{index,media-ref,conflict-checks}.ts` report as unreachable.**~~ **RESOLVED — and the stated hypothesis was WRONG.** The guess recorded here was "knip cannot follow the module registry's dynamic resolution". That is **refuted**: there is no dynamic resolution involved. The cause is the *same* production-mode entry bug already fixed for `apps/server`, in its other form — `packages/modules/package.json` declares `./notes` and `./notes/screens` subpath exports, but `knip.json` gave that workspace **no `entry` at all**, so only the default `src/index.ts` applied, and that entry deliberately imports `./notes/manifest.js` rather than the barrel (`src/index.ts:18-30` — to keep react-native off the server graph). The 10 files were live the whole time: `apps/mobile/{App.tsx:58, index.ts:5, src/screens/notes/NotesHome.tsx:16, src/screens/notes/runtime-adapter.ts:11-12, src/bootstrap/Root.tsx:51, src/bootstrap/notes.ts:29}`. Fixed by giving the workspace its three real entries; file findings 39 → 29.

### Review round 2 — three defects found, fixed 2026-07-22

The reviewer demonstrated the round-1 gate going **green with a dead production file present**. All three fixes are in `scripts/check-unused-exports.mjs` / `knip.json` / `knip-baseline.json`.

1. **`migrations-dir` swallowed live production source (HIGH).** `/(^|\/)migrations\//` was written for `packages/db-server/migrations/**` (Kysely loads those dynamically by filename) and also matched `packages/db-client/src/migrations/**` — four LIVE files on a plain static import chain, `db-client/src/index.ts:37` → `migrations/runner.ts:3-4` → `001`/`002`. The realistic bug it hid: add `003-*.ts`, forget to register it in `CLIENT_MIGRATIONS`, and it **never runs on device** while the gate prints `no new unused production files` / `EXIT=0`. Fixed by **the `src/` invariant**: a path under a package's `src/` may be excluded only by a *literal test-filename* rule, never by a directory rule. Measured over all 829 tracked JS/TS files — 424 match some rule; of the 108 under `src/`, 104 are literal test files and the 4 remainders were exactly those migrations.
2. **The canary header made a false claim (HIGH).** It stated that a partition widening over `src/` would take the file canary with it. It would not — the canary is one file at one path and only sees widenings that cover `packages/test-support/src/`. The reviewer's probe swallowed an `src/` path with the canary **present and the gate green**. Header corrected in both the script and `knip-file-canary.ts` to state what the canary does and does not cover. Recorded rule *names* likewise only make rule **addition** reviewable, not rule **widening** — widening is now contained by construction instead.
3. **`packages/modules` had the same entry bug as `apps/server` (MEDIUM)** — see finding 2 above, now resolved.

**The trade in fix 3, recorded deliberately.** Giving `packages/modules` its real entries converts 10 false *file* findings into **8 false *export* findings** (`notes/screens/{NoteDetail,NoteEditor,NotesList,runtime,i18n}`, `notes/conflict-checks`), because knip resolves cross-workspace imports to `dist/` and cannot see `apps/mobile` consuming them — the same pre-existing class as the already-baselined `packages/modules/src/index.ts#ALL_MODULES`. This was judged worth it because **the two errors are not symmetric**: a false *file* finding is a live file permanently baselined as dead, so the gate stays green forever if it genuinely dies *and* a future cleanup could delete a live screen citing this baseline. A false *export* finding is an accepted row that can never hide a file death. The trade converts a hazard into inert noise, and it makes the file half accurate for the notes screens, which are actively developed. Export baseline 123 → 131; file baseline 39 → 29.

**A guard that would otherwise have been inert.** The `src/` invariant changes no count in a clean tree — nothing today reaches under `src/` — so deleting or typo'ing it would have stayed green indefinitely (§2.11). `assertPartitionInvariant()` therefore checks `classify()` as a *function*, before knip is even spawned, against the exact regression that motivated it plus both collapse directions. Falsified three ways: deleting the invariant, emptying `SRC_EXCLUDABLE_RULES`, and mangling `SRC_PATH` each fail loud and name the offending case.
