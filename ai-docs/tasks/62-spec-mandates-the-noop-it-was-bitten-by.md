# TASK 62 — `08 §5.6`'s normative build rule prescribes, as its worked example, the exact no-op that has now failed four times

**Status:** done
**Priority:** **MEDIUM — but it is an active instruction, not a passive error.** Nothing is broken today (task 55 fixed the live instances). The defect is that the spec tells the *next* agent to do the thing that failed four times, and it reads as authoritative because it is.
**Depends on:** 55
**Blocks:** —
**SEC ids owned by THIS task:** none

## The finding (task 55's sweep, 2026-07-15)

`ai-docs/08-stack-and-repo.md:284`, normative, verbatim:

> **any test script that imports a built cross-package entry MUST prefix `tsc -b &&`** (e.g. `"test": "tsc -b && vitest run"`)

The rule is right. **The worked example is the bug**, and the example is what gets copied.

`tsc -b` with no argument builds **the tsconfig in the script's own working directory** — which for a *package-level* script is that package's tsconfig, not the root solution file. So:

| where | `tsc -b` resolves | result |
| ----- | ----------------- | ------ |
| a **root** script (`package.json` at repo root) | root `tsconfig.json` — a real solution file (**10 references**, verified) | builds everything. **The rule works.** |
| `apps/mobile` | its own tsconfig — **no `references`**, and §5.6 itself forbids `composite` | **no-op.** Silent. |
| `packages/db-client` | its own tsconfig — `noEmit`, no `references` | **no-op.** Silent. Needs `tsc -b ../..`. |

The spec's example is a **package-level** script (`"test": …`, the shape every `packages/*/package.json` uses). Copied literally, it is a no-op that looks exactly like compliance.

## Why this is worth a task and not a one-line edit

**Four agents have now been bitten by this, and the spec was the instruction each time:**

1. **Task 24** — discovered `tsc -b` in `apps/mobile` is a no-op (no `references`; `composite` forbidden by §5.6 itself).
2. **The orchestrator** — prescribed `tsc -b &&` as a fix, which was *itself* a fake green for the same reason; corrected to `tsc -b ../..`.
3. **Task 55** — `packages/db-client`'s `test` script needed `tsc -b ../..`; a bare prefix would not have built anything.
4. **Task 55's sweep** — found a **fourth**, live in CI: `db-client`'s bare `vitest run` imports dist-only `@bolusi/test-support`, so the driver-conformance suite — *that job's entire purpose* — contributed **zero tests behind an 85-test green**.

Every one of those is an agent doing what §5.6 says. **A spec that produces the same defect four times is not being misread.**

Note the shape (T-15): §5.6's surrounding prose is *excellent* — it explains why `needs: [typecheck]` is false comfort (separate runners, no shared filesystem), it cites task 03, it names the fake-green risk and links T-14c. It is careful, correct, and reasoned. **That is exactly why nobody questioned the example underneath it.** The authority of the paragraph is what licenses the copy-paste of the one line in it that doesn't work.

## The real invariant (state this, don't restate the mechanism)

The rule §5.6 *means* is: **before a test lane runs, the dist it imports is current.** `tsc -b &&` is one mechanism, correct only when the resolved tsconfig is a solution file that actually builds the imported packages. The spec currently normativises the **mechanism** and omits the **invariant** — which is why the mechanism gets copied into places it cannot hold.

Task 55's gate (`scripts/check-test-script-builds.mjs`) already enforces the invariant — it checks the prefix *reaches the dist*, and (per its own falsification) **flags a bare `tsc -b` that a grep-shaped gate would pass**. So the code is honest and the spec is not. That asymmetry is the whole task: **the gate now knows something the spec doesn't say.**

## Docs to read

- `ai-docs/08-stack-and-repo.md` **§5.6** (the whole CI-pipeline section, esp. line 284 and the `unit`-job reasoning), §4 (consumed-from-`dist/`), lines 198-200 (root solution file; `apps/mobile` doesn't emit; **`composite` forbidden** — the constraint that makes the mobile case unfixable by adding `references`).
- `ai-docs/tasks/55-*.md` §Outcome — the four instances, the gate, and its falsification (incl. the bare-`tsc -b` case a grep-shaped gate passes).
- `ai-docs/tasks/24-*.md` — the first discovery.
- `scripts/check-test-script-builds.mjs` + `packages/test-support/src/test-script-builds.test.ts` — **the executable form of the invariant.** The spec should describe what this enforces; do not invent a second definition (§2.8).
- `ai-docs/testing-guide.md` T-14c (a stale build is a fake green), **T-15** (a comment/spec that authoritative is why nobody checks), **T-16** (answer existence by producing the artifact).

## Acceptance

**Observable done-condition:** an agent following §5.6 literally, for a package-level script, produces a script that actually builds — and the spec's example cannot be copied into a no-op.

- **Doc-first and doc-only.** This is a spec change (§4); it is the task. Do not touch `package.json` scripts — task 55 already fixed the live instances; if you find a new one, **file it**, don't fold it in.
- **State the invariant, then the mechanism.** Normativise *"the dist a test lane imports is current before vitest starts"*, and give the mechanism per location: root script → `tsc -b`; package-level script → **`tsc -b ../..`** (or the correct relative path to the solution file). **Say why**, in one clause — `tsc -b` resolves the cwd's tsconfig, and `packages/*` tsconfigs are not solution files. An agent who knows *why* will not copy it into the wrong place; one who has only the rule will.
- **Name the trap explicitly**, because it is the thing that recurs: **a bare `tsc -b` in a package-level script is a silent no-op that looks like compliance.** §5.6 already has form for this — its `needs: [typecheck]` paragraph exists precisely to kill a plausible-but-wrong approach. Give the no-op the same treatment.
- **Point at the gate.** §5.6 should say the invariant is enforced by `check-test-script-builds.mjs` and that **the gate, not the prose, is the authority** — so the next agent who finds them disagreeing knows which one is wrong. Cite the denominator the gate states (10 vitest scripts / 10 dist-only packages), and say a new dist-only package or vitest script must appear in it.
- **`apps/mobile` is the load-bearing example** — record that `composite` is forbidden there (§5.6's own rule) so `references` is not the escape hatch, which is why `tsc -b ../..` is the answer and not a workaround. Task 24 paid for that fact; do not make a fifth agent re-derive it.
- **Verify before you write** (T-16 — this task is *about* an unverified claim, so do not add another): confirm the root tsconfig's reference count yourself; confirm `apps/mobile`'s and `packages/db-client`'s tsconfigs lack `references`; confirm `tsc -b` in each location is/isn't a no-op **by running it**, not by reading it. Every number in your edit carries its `EXIT=` line.
- **Check the sibling rules** (T-12): does §5.6 prescribe any *other* mechanism-as-example that is location-dependent? The `pnpm dev` row (`tsc -b --watch`) and the `pnpm typecheck` row (`tsc -b`) are both root-scoped and fine — confirm, don't assume. Anything else that a package-level copy would silently break?
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green — **read the output, not the exit code** (§2.1). A docs-only change should move none of them; if it does, say why.

## Note

Filed by the orchestrator from task 55's report; impl-55 identified the defect, correctly declined to fix it inside a build task (§4), and flagged it as *"the spec still tells the next agent to do the thing that failed twice."* It has now failed four times.

Worth carrying: this is the **fifth** distinct thing in this repo whose failure mode is *"authoritative prose that is wrong in one specific clause, surrounded by reasoning good enough that nobody audits the clause."* The others: `keystore.ts:16-18` (an iOS-only option credited with an Android guarantee), `notifications.ts:4` (states Android's rule, violated twelve lines below), `PinScreen.tsx:52` (names a gate nothing calls), and `13-auth-server.md:60-61` (disclaims two SEC legs to four tasks, none of which own them). **All five are comments or specs. None is a test.** No gate in this repo reads any of them — which is why §5.6's fix is not "write it more carefully" but **"point the prose at the executable check and say the check wins."**
