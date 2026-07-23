# TASK 172 — `pnpm ci:status` classifies a red job as OWED by JOB NAME alone and never calls `assert()`, so task 154's scope check does not reach the command the team actually runs after every push

**Status:** todo
**Priority:** MEDIUM — bigger blast radius than the two residuals it sits beside (166, and the dispatch-only lane task), because this is the command run after *every* push to main, by people and agents alike. Pre-existing from task 142, not introduced by 154. Self-closing the day SEC-AUTH-09/10 discharge.
**Depends on:** 142, 154
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-154 reviewer, 2026-07-23, confirmed by the coordinator observing it in normal use.

## The finding
`scripts/ci-status.mjs` decides whether a failing job is OWED with:

```js
const expected = expectedByJob.get(job.name);
if (expected === undefined) unexpected.push(job);
else owed.push({ job, expected });
```

That is the **job name** and nothing else. `expected.assert()` — the function task 154 tightened to require the failing SEC id set ⊆ {SEC-AUTH-09, SEC-AUTH-10} — is **never called here**, and cannot be: this command reads the `gh` job-list API, so it has no log text to assert against.

**Consequence.** A `security-sweep` job red for a **completely new** reason — the secrets scan, the dependency audit, a test lane, the frozen-lockfile check, a new SEC id — still prints `OWED`, is excluded from `unexpectedTotal`, and the command exits 0. Task 154 closed this hole inside `pnpm verify`, which classifies against the sweep's actual output. In `ci:status` it remains fully open.

This is the *same* defect 142 was created to fix (a real failure hiding behind a permanent red), surviving in the very command 142 shipped to prevent it.

## Why it is a task and not a fold-in
Closing it means fetching the job's **logs** (`gh run view --log --job <id>`) and running `EXPECTED[...].assert()` on the `security-sweep` step's output. That is a real cost and complexity change: an extra API call per owed job, log volume, and a new failure mode when the log is unavailable or truncated. It needs its own design, and it must obey 154's rule — **a log that cannot be fetched or parsed is UNEXPECTED, never OWED**, because "could not look" is not "as expected".

## Deliverable (sketch, not a mandate)
1. For a failing job carrying an `expect`, fetch that job's log and run `EXPECTED[...].assert()` on it — the same oracle `pnpm verify` uses, so the two commands cannot disagree (that shared-oracle property is the whole point of deriving OWED from `STEP_POLICY` + `EXPECTED`).
2. `assert()` returning `ok:false` → UNEXPECTED, counted, with its `detail` printed.
3. Log unavailable / truncated / unparseable → UNEXPECTED (or an explicit `UNREADABLE` that still exits non-zero). Never a silent OWED.
4. Keep the cost sane: only for jobs that are both failing and carry an `expect`.

## FALSIFY (§2.11 — REPORT it)
- **Before:** take a real `security-sweep` red, mutate the transcript to add a failure OUTSIDE the SEC inventory (e.g. `EXIT=1  secrets scan`), and confirm today's `ci:status` still prints OWED and exits 0.
- **After:** the same input must print UNEXPECTED and exit non-zero, naming the offending step.
- **Positive control:** the genuine current red (only the SEC inventory, only 09/10) must still print OWED — otherwise `ci:status` reds on every run and gets ignored, which is worse than the hole.
- Falsify the log-fetch path itself: no log, empty log, truncated log, job id that 404s. Every one must be loud.

## Cross-reference — three instances of one class
This is the **third** instance found in two days, and they are worth reading together:

| where | what is scoped | what is not |
| ----- | -------------- | ----------- |
| task 154 (fixed) | the failing STEP is the SEC inventory | *which ids* it is red for |
| task 166 | the failing IDs are the owed ones | *which failure mode* those ids are red for |
| **this task** | the failing JOB is `security-sweep` | *anything at all about why* — `assert()` is never called |

> The OWED / exclusion machinery scopes what it exempts **by name**, not by **what the exemption is actually licensing**.

The dispatch-only-lanes task (filed as 163) is the same shape one file over: `dispatchOnly` names the jobs no local command reproduces and thereby stops inspecting their contents entirely. Fixing any one in isolation leaves the class open.
