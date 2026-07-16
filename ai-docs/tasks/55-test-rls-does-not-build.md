# TASK 55 — `test:rls` doesn't build: the project's ONLY real-Postgres lane cannot resolve `@bolusi/core` in CI
**Status:** in-review
**Priority:** **HIGH** — this lane carries every real-driver claim in the project, including task 46's guard for a class that had a *live production bug*. Third violation of the same normative rule.
**Depends on:** 46

## Why this is a PRECONDITION, not hygiene (review-04, task 48 review)

> **"Task 55 isn't just a hygiene fix — it's what makes 46's and 48's refusals load-bearing."**

Tasks 46 and 48 both chose to **refuse rather than coerce**: the int8 seam throws above 2^53 instead of rounding; `boolColumnToBoolean` enumerates and throws instead of guessing. Both refusals are correct, and both rest on the same promise — *"this fails **loudly** the day the assumption stops holding."*

**The thing that would notice is `test:rls`.** It is the only lane running the production `pg` driver, so it is the only place a `setTypeParser`, a driver swap, or a text-mode read would surface. **And today it reads stale `dist`.** So the refusals' entire value — *loud, immediate, caught by the first test run* — is currently underwritten by a lane that cannot see the change that would trigger them.

Until this lands, tasks 46 and 48 are correct code with an unenforced guarantee.

## The finding (task 48, confirmed by the orchestrator)

**Evidence, each verified:**
- `"test:rls": "BOLUSI_DB_ENGINE=postgres node scripts/db-lane.mjs --db=bolusi_rls_test -- vitest run --project db-server"` — **no `tsc -b`**.
- `scripts/db-lane.mjs` — **does not build**.
- Root `package.json`'s only `prepare` is `git config core.hooksPath .githooks` — **no build on install**.
- `@bolusi/core`'s `exports` are **dist-only**: `"." → { types: "./dist/index.d.ts", default: "./dist/index.js" }`. Neither vitest config aliases it to `src`.
- **Three** db-server tests import `@bolusi/core`: `sync-batch-atomicity.test.ts` (task 16), `projection-int8-marshalling.test.ts` (task 46), and task 48's decoder suite. (review-04 independently confirmed the count and the mechanism; `test`/`test:server` both carry a `tsc -b`, `test:rls` alone does not.)
- CI's `rls-witness` job runs: checkout → `corepack enable` → setup-node → `pnpm install --frozen-lockfile` → `check-tenant-context.mjs` → `db:stamp` → **`pnpm test:rls`**. **No build step anywhere.**

**So after a fresh checkout there is no `dist`, and those two tests cannot load** — the exact `Failed to resolve entry for package "@bolusi/core"` failure seen repeatedly in fresh worktrees today.

**08 §5.6 is normative:** *"any test script that imports a built cross-package entry MUST prefix `tsc -b &&`."* This is its **third** violation, each found separately after shipping: task 32 repaired `test:server`, task 24 repaired the mobile lane (and found the naive fix insufficient — see below), and now the rls lane. **A rule violated three times isn't enforced; it's remembered, badly.**

## Why this is HIGH and not a chore

`test:rls` is the **only lane that runs the production `pg` driver**. Everything else runs better-sqlite3 or PGlite, which return `int8` as a **number** where `pg` returns a **string** (T-14f). That difference produced a live production bug: `highestContiguousServerSeq` never advanced (task 46).

**Task 46 built `projection-int8-marshalling.test.ts` specifically to catch that class — and it is one of the two tests that cannot load in CI.** The guard for the bug every other lane was blind to sits in the lane that doesn't run.

**And locally it's worse than absent — it's a liar.** Task 48 hit this and nearly published it:
> *"My first staged reproduction tested **stale pristine dist** while source maps pointed the trace at `src` — **it looked live**. Discarded and re-run. Any rls-lane falsification without `tsc -b` reads the same unchanged bundle twice."*

Locally `dist` usually exists (left by a prior `pnpm test`), so the lane runs — **against whatever was built last**. Edit `core/src`, run `test:rls`, and you are testing the old bundle. **Every falsification anyone has done through this lane is only valid if they rebuilt.** Tasks 46 and 48 both did (and said so). Nobody was forced to.

## Docs to read

- `08-stack-and-repo.md` **§5.6** — the normative rule and its two recorded repairs. Read task 32's and task 24's entries; you are the third.
- `package.json` (`test:rls`, and the root `test`/`test:server`/`test:appliers` which **do** comply), `scripts/db-lane.mjs`.
- `.github/workflows/ci.yml` — the `rls-witness` job.
- `ai-docs/tasks/24-app-shell.md` — **read its FIX 1 before writing yours.** The naive `tsc -b &&` was **still a fake green** there: `tsc -b` resolves the *nearest* tsconfig, and if that project has no `references` it builds nothing. Only `tsc -b ../..` (the root solution file, which holds every reference) worked. **Check which tsconfig your prefix resolves and prove it rebuilds.**
- `testing-guide.md` T-14c (stale build = fake green), T-14f (both engines ≠ both drivers), T-11.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- Real Postgres via the task-34 lane: `pnpm db:up` (read output), confirm `attribution OK … owned by '<your project>'` (T-14d), `pnpm db:down` after.

## Acceptance

**Observable done-condition:** from a tree with **no `dist`**, `pnpm test:rls` builds and runs — and editing `packages/core/src` changes what the lane observes.

- **Reproduce both failures first** (T-11): (a) wipe every `dist`, run `pnpm test:rls`, watch it fail to resolve `@bolusi/core` — that's CI; (b) with `dist` present, edit a `core/src` file the rls tests exercise, run `pnpm test:rls` **without** rebuilding, and watch it report the **old** behaviour — that's the local liar. If either doesn't reproduce, the premise changed: **stop and report**.
- **Fix the script**, and **prove the prefix actually rebuilds** — do not assume `tsc -b` resolves the solution file (task 24's trap). Show the build output changing `dist` before vitest runs.
- **Fix CI**, or state why the script fix suffices. The `rls-witness` job must build before `test:rls`, or the script must do it.
- **Falsify** (§2.11): with the fix, an edit to `core/src` **changes the lane's result** without a manual rebuild; revert the fix → the lane goes back to reporting stale. That is the whole property.
- **Sweep the class** (T-12) — this is the third instance, so **enumerate every script that runs tests**, and for each: does it import a built cross-package entry, and does it build? Name the total and the verdict per script. §5.6 has now been violated three times by three different agents; **the deliverable is a check that makes a fourth impossible**, not a fourth repair. Consider a gate that fails when a test script imports a `dist`-resolved workspace package without a build prefix.
- `pnpm test`, `pnpm test:rls`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Outcome

**Both failures reproduced first, then fixed, then falsified. Real PG 16.14, attributed to this
worktree's own compose project (`owner 'agent-abe5e7ded7f3279ca'`) on every run.**

| # | reproduction (before the fix) | measured |
| - | ----------------------------- | -------- |
| a | **cold / CI**: no `dist`, `pnpm test:rls` | `Failed to resolve entry for package "@bolusi/core"` ×3 · **3 failed \| 12 passed (15)** · `Tests 90 passed (90)` · `EXIT=1` |
| b | **warm / local liar**: task 46's 2^53 refusal deleted from `packages/core/src`, no rebuild | **`Tests 10 passed (10)` · `EXIT=0`** |

(a) is the loud half, and its shape is the point: the run still *reports* "90 passed" — those 90 are
the 12 files that don't import core. **The three that carry every real-`pg` claim contributed zero
tests**, and a reader who checks the summary rather than the file count sees a healthy number.

(b) is the dangerous half. The deleted line is the exact one task 46 falsified as "narrowing throw
removed → red". It reported **10/10 green on real Postgres** because `dist` was stale.

**Fix:** `"test:rls": "tsc -b && …"` — a root script, so a bare `tsc -b` resolves the ROOT
`tsconfig.json`, which *is* the solution file (10 references). Verified, not assumed: task 24's trap
is real but does not apply here, and the same check said `@bolusi/db-client` needed `../..`.

**Falsification (§2.11) — the property is "an edit to `core/src` changes the lane's result with no
manual rebuild". Same broken source, same stale-green `dist`; the only variable is the prefix:**

| `dist` at start | script | real-PG result |
| --- | --- | --- |
| stale (green content) | **without** `tsc -b` | `Tests 10 passed (10)` · `EXIT=0` — **the liar** |
| stale (green content) | **with** `tsc -b` | `Tests 1 failed \| 9 passed (10)` on `/exceeds/` · `EXIT=1` |

Broke the refusal → lane went red **on its own**; a pre/post grep of `dist` showed the probe absent
before the run and present after, so the script's own `tsc -b` did the rebuild. Restored → `10
passed (10)` · `EXIT=0`, `src` byte-identical to HEAD (`git diff` empty). The test is not inert:
against a *manually* rebuilt `dist` the same edit was already red, so (b)'s green was staleness
alone.

**Observable done-condition, met:** from a tree with **0** `dist` directories, `pnpm test:rls` →
**15 passed (15)** · **`Tests 119 passed (119)`** · `EXIT=0`. The three real-driver files now
contribute the **29** tests they previously contributed none of (119 − 90).

### The deliverable is the gate, not the prefix

`scripts/check-test-script-builds.mjs` + `packages/test-support/src/test-script-builds.test.ts`
(11 tests). It **resolves the `tsc -b` project graph** — arg → tsconfig → `references`, transitively
— and asks whether the needed package's `dist` is actually emitted. It does **not** grep for
`tsc -b`, because task 24 proved a *present* prefix can build nothing: that is the ninth-fake-green
shape this repo keeps shipping, and a grep-shaped gate would have certified it. Falsified both ways:

- prefix deleted from `test:rls` → gate `EXIT=1` naming the script; unit tests **2 failed \| 9
  passed** · `EXIT=1` (the CI-visible red). Restored → green.
- db-client's `tsc -b ../..` → bare `tsc -b` (builds nothing; **a grep gate passes this**) → still
  flagged, `EXIT=1`. Restored → green.

It fails **closed on its own blindness** (§2.11) — see the next section for what that took. Green
output states its denominator: `10 test scripts checked, 10 dist-only packages`. Wired into CI
stage 1 (static — names the offending script in seconds) *and* stage 4 via the unit test.

### The gate shipped the very bug it was written to prevent (review-55, MEDIUM)

Worth reading before trusting any guard in this repo, this one included. The first cut failed
closed on two **global** conditions (zero scripts / zero dist-only packages) and I wrote that up as
"fails closed on its own blindness". **It was open per-script.** `targetDirs` resolved
`--project <name>` by scraping `name: '...'` out of vitest configs and **silently dropped names it
couldn't map** (`.filter((d) => d !== undefined)`) → empty target list → empty needed-set → a
confident green. The denominator could not see it: the script was still **counted**, just checked
against nothing.

Review-55's reproduction, which I confirmed: `const N = 'server'; … name: N` (an ordinary
extract-a-const refactor) plus the prefix removed from `test:server` → old gate printed `10 test
scripts checked … every cross-package import is built first` · `EXIT=0`, **all 11 unit tests
green**, through prettier, lint and typecheck. That is the ninth instance of this repo's signature
failure, **inside the file written to stop it** — which is the honest measure of how strong the pull
toward a vacuous green is.

Closed at both ends, per-script and at the source: an unmappable `--project` is a reported
violation, and a `vitest.config.ts` whose name the scraper cannot read fails the whole run rather
than quietly leaving a project out of the map. Falsified four ways:

| sabotage | result |
| --- | --- |
| `const N = 'server'` + prefix removed (review-55's exact case) | gate `EXIT=1` naming the config; unit tests **3 failed \| 11 passed** `EXIT=1` |
| ``name: `server` `` (template literal) | gate `EXIT=1` naming the config |
| config readable, prefix removed | gate `EXIT=1` — original prong, names all 4 needed packages |
| prefix present, `--project srever` (pure vacuous-pass) | gate `EXIT=1` — "refuses to pass it" |

All restored; gate back to `EXIT=0`. My own new check also produced a **false positive** on first
run — it read the ROOT `vitest.config.ts` (the `projects: [...]` aggregator, which correctly has no
`name`) as an unreadable project. Caught by running it, not by reading it.

Test 10's tripwire was generalised from the instance to the class (T-12): it pinned only
`test:rls`'s needed-set, so every *other* script could go blind silently. Now every script's
`unresolved` must be empty, every lane known to import a dist-only package must be **seen** to need
one, and `projectDirs` must account for **all 13** `vitest.config.ts` files on disk.

**Stated, not fixed (§2.11 — a gate implying coverage it lacks is worse than none).** The gate's
header now enumerates what it cannot see, each verified against this repo rather than guessed:
dynamic `await import('@bolusi/x')` is **not** matched — live at
`packages/core/test/sync/loop.test.ts:278`, harmless only because line 21 imports the same package
statically, so it is **masked, not absent**; `.js`/`.mjs` are unscanned (no live instance — the only
`.js` tests are tooling/eslint's rule tests whose `@bolusi/*` mentions are RuleTester `code:`
fixture strings, which is also why naively globbing `.js` would manufacture false alarms); and
`emits` reads a tsconfig's own `outDir`, so one inherited via `extends` would be misread (no
instance today). None can false-alarm; all can fail to notice. A green here means "no violation
among the imports this gate can see" — strictly weaker than "no violation".

**CI:** no build step added to `rls-witness`, deliberately. `tsc -b` inside the script is
runner-independent and fixes **every** caller — a job-level build would have fixed CI while leaving
every local run and every falsification reading whatever `dist` it found. This mirrors what
`server-integration` already documents for `test:server`. Comment added at the job saying so.

### The sweep found a FOURTH violation, live in CI (T-12)

**10 vitest-invoking test scripts; 10 dist-only packages. Two were violations, not one.**

| script | needs `dist` of | before |
| ------ | --------------- | ------ |
| `bolusi::test` / `test:server` / `test:appliers` / `test:ed25519-interop` | core, schemas, db-server, db-client, test-support, i18n, ui | ok — carry `tsc -b` |
| `bolusi::test:rls` | core, schemas | **VIOLATION** (this task) |
| `@bolusi/db-client::test` | test-support | **VIOLATION — found by the sweep** |
| `@bolusi/mobile::test` | core, i18n, ui | ok — `tsc -b ../..` (task 24) |
| `@bolusi/core::test` | db-client, schemas, test-support | ok — names both tsconfigs |
| `@bolusi/schemas::test`, `@bolusi/ui::test` | — | n/a — import no dist package |

`packages/db-client`'s `"test": "vitest run"` had **no build** while
`test/driver-conformance.test.ts:8` really imports dist-only `@bolusi/test-support`. CI's
`db-client` job runs exactly that script, and its `pnpm -F @bolusi/db-client build` does **not**
help: `db-client/tsconfig.build.json` references only `../core` and `../schemas` (correct —
test-support is a devDep and builds exclude tests). Measured in CI's own state: `Failed to resolve
entry for package "@bolusi/test-support"` · **1 failed \| 5 passed (6)** · `Tests 85 passed (85)` ·
`EXIT=1` — the driver-conformance suite, the job's entire purpose, contributing **zero** tests
behind an 85-test green. Fixed with `tsc -b ../..` (a bare `tsc -b` there is task 24's no-op:
`db-client/tsconfig.json` is `noEmit` with no references). Cold-tree after: **6 passed (6)** ·
`Tests 87 passed (87)` · `EXIT=0` — the 2 conformance tests now run.

So §5.6 was violated **four** times by four agents, and the fourth was found only by asking the
class question. `test:jcs-hermes` is out of the gate's scope by construction (esbuild bundle, no
vitest, no dist resolution).

**Acceptance, each read from the command's own log next to its `EXIT=` line (§2.1):** `pnpm test`
**177 files / 2563 passed | 3 skipped** `EXIT=0` · `pnpm test:rls` (cold, real PG 16.14, attributed)
**15 files / 119 passed** `EXIT=0` · `pnpm lint` `EXIT=0` · `pnpm typecheck` `EXIT=0`.

## Note

Found by task 48 while falsifying its own fix — it noticed its first reproduction *looked* live because source maps pointed at `src` while the runtime read a stale bundle. It discarded the result rather than publish it. That instinct is the only thing that caught this: **the lane fails silently in the direction of agreement.**

The irony is worth recording. Task 46 exists because every test lane used a non-production driver. It built the one lane that uses the real driver — and that lane doesn't run in CI and doesn't rebuild locally. **The guard against "green for the wrong reason" was itself installed somewhere that can only be green for the wrong reason.**
