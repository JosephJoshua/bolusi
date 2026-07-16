# TASK 68 — wire the semantic unused-export sweep (`knip`) as a pinned dep + CI gate; task 60 proved the config, nothing runs it

**Status:** todo
**Priority:** MEDIUM — the sweep exists and is proven (`knip.json` is in the repo, with controls). What is missing is a dependency, a script, and a gate. Today the config is a document, not a mechanism.
**Depends on:** 60 (which produced and falsified the config)
**Blocks:** —
**SEC ids owned by THIS task:** —

## Why this exists

Task 60 needed to answer *"what else is exported, tested, and uncalled?"*. The orchestrator's grep sweep answered **109 findings / 462 exports** and missed the one case it was written for. Task 60 replaced it with `knip`, which answers the question semantically (TypeScript language service, not text).

`knip.json` landed with task 60. **`knip` itself did not** — task 60 ran it via `pnpm dlx knip@6.27.0` rather than edit the contended root `package.json`/lockfile with ~20 agents in flight (§4, §6). So the config is currently unexecutable by anyone who doesn't know the command.

## The command that reproduces task 60's numbers

```
pnpm dlx knip@6.27.0 --production --include exports --no-progress   # 106 — unreachable from PRODUCTION entries
pnpm dlx knip@6.27.0 --include exports --no-progress                #  38 — unreachable from ANY entry (tests included)
```

The **difference (76)** is the interesting set: *exported, exercised by tests, never called in production* — the decoy/test-only class. The **intersection (30)** is *called by nothing at all*.

## What the config's three settings cost to learn (do not "simplify" them away)

Each was found by a control failing, not by reading docs:

1. **`includeEntryExports: true`** — without it, knip **does not report exports of entry files** (its documented default). Every `packages/*` re-exports its public API through `src/index.ts`, so the entire library surface — including the tracked orphans of 43/49/50 — was **invisible**. First run: `packages/core` reported **zero**. A sweep silently checking nothing (§2.11).
2. **`ignoreExportsUsedInFile: true`** — without it, knip reports "this `export` keyword is unnecessary", **not** "this is uncalled". `hasPermission`, `redactSecrets`, `defaultBodyCaps`, `verifyPassword`, `parseBearer` are all **live code called in their own file**. They are not findings. This setting is what makes the output mean *"is this called?"*.
3. **`workspaces['apps/server'].entry`** — `src/main.ts` (`tsx watch src/main.ts`) and `src/cli/*.ts` (`pnpm provision-tenant`) are real production entries that **no `exports` field mentions**. Without them `randomBase58`, `DEFAULT_ROLES`, `appendSystemOp`, `InMemoryTokenStore` were reported as dead **while being called** — false positives with a confident number, the same failure as the grep.

## Acceptance

- Add `knip` as a root devDependency, **pinned exactly** (§2.1 / 08 §2.1 — no `^`), matching the version whose output is quoted above; lockfile updated. **This edits the contended root manifest — serialize it** (§4).
- Add a script (`pnpm sweep:exports` or similar) for both lanes above.
- **The gate must assert its own denominator** (T-14). A `knip` that finds nothing because its entries broke is **green**, and that is exactly how settings 1 and 3 failed here. Do not ship a bare `knip && echo ok`. Options: assert a floor on the analysed file/export count, or keep an intentional known-dead fixture that the sweep MUST report (a positive control that fails loudly if the sweep goes blind).
- **Falsify it before believing it** (§2.11/T-11): make a live export unreachable, watch the sweep report it; make the sweep blind (drop `includeEntryExports`), watch the control go **red**. Report "broke X, saw Y fail, reverted".
- Decide the baseline: 106/38 is too many to gate on today. Either gate only `apps/*`, or snapshot the current set as an accepted baseline and fail on **additions** (`--no-gitignore`/`--reporter json` + a checked-in baseline).

## Note

Task 57 asks for a gate on *dangling re-exports*; this is its sibling and they may share a lane — but they are different questions (57: a re-export resolving to nothing; 64: an export nothing calls). Do not merge them without checking that one instrument answers both.

**And read §2.11 before configuring this.** Of the four sweep configurations task 60 ran, **two were green-because-blind** and were caught only by a control (`canAttempt` must appear; the known orphans must appear). A sweep is a guard, and this repo's guards have failed by silently checking nothing more often than by any other cause. **If your sweep cannot see `canAttempt`'s replacement, it is checking nothing** — and it will report a large, confident, useless number while doing it.
