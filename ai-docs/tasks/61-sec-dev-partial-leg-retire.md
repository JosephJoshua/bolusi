# TASK 61 — SEC-DEV-04/05's client legs are retired by a "(server leg)" title: the same class task 54 was filed for, still open

**Status:** done
**Priority:** **HIGH** — these are **live holes with a green light over them**. Unlike task 54's ids (whose server legs turned out to be shipped — see 54's Outcome), the legs below are genuinely unshipped, unowned, and invisible to SEC-META-01.
**Depends on:** 31
**Blocks:** 28 (its roll-up assumes every SEC id is either titled or allowlisted)
**SEC ids owned by THIS task:** none

## Outcome (2026-07-15) — the gate half shipped; the ownership half was refuted by reproduction

**The gate defect was real, is fixed, and has been watched going red.** The "ship SEC-DEV-04's client leg" instruction was **not executable**: two of §218's five behaviours contradict api/02-auth §7.3 and cannot be built as written. Filed as **task 70**; three of the five shipped here.

### 1. The gate — `partialLegTitles` (`packages/test-support/src/sec-meta.ts`)

Task 31's stated residual (*"Can a partial-coverage title still claim an id? Yes — when no row exists… retiring an id needs title→task attribution the gate does not have"*) is **closed, and it needed no attribution.** When **every** title claiming an id carries a partial-leg qualifier (`leg(s)`/`arm(s)`/`precursor`/`partial`), the titles *themselves* say no test claims the whole id. If nothing declares it either, the id is retired by a claim its own author disowned — decidable from the titles alone.

Three escapes, all declarative, none prose (task 31's rails, not a second mechanism): an **unqualified title** (the completing test, §2.1.6) · an **allowlist row** · a **marker declaration**.

**Found 5 ids on real data, with ZERO false positives across the other 51** — including the two `SEC-DEV-04/05` this task was filed for, `SEC-AUTH-06/11` (task 54's deferred pair, which no gate could see before), and **`SEC-DEV-07` — a 17th instance nobody had reported**. `SEC-SYNC-02` and `SEC-AUTH-04` correctly do **not** fire despite carrying qualified titles, because each also has an unqualified title that completes it — which is exactly why the rule is not a blunt "no qualifier anywhere".

**Falsified (§2.11), not asserted:** restored `sec-dev.test.ts`'s `SEC-DEV-04 (server leg)` title, removed its allowlist row and its marker — the exact state that was live and green — and the gate went **red**: *"SEC-DEV-04 → every title claiming it concedes it is a partial leg … no allowlist row, and no marker declares it"*. Restored → green. Separately, neutering the qualifier vocabulary so it matches nothing turned the **denominator** red (`titles carrying both a SEC id and a partial-leg qualifier: expected 0 to be greater than 0`, 3 failed | 15 passed, EXIT=1) — so the rule cannot silently check nothing (T-14). Denominator now reported and floored: **56 ids · 2089 titles · 63 task files · 14 declared ids · 44 ids with titles · 6 partial-leg-qualified titles**.

### 2. SEC-DEV-04 — the premise moved; the leg is not "unshipped", it is **unbuildable as written**

The orchestrator's ruling ("this task owns it and ships it") was challenged with evidence, as its own brief permitted. A reproduction drove the real `SyncLoop` through offline → revoked → reconnect:

| # | §218 requires | reality | |
| - | ------------- | ------- | - |
| 1 | continues local operation | `backoff`, `syncDisabled: 0`, ops append + queue | **holds — shipped here** |
| 2 | queued ops → `DEVICE_REVOKED` | `{status: 'local', code: null}` — no marking | **never happens** |
| 3 | kept | 3 rows survive | **holds — shipped here** |
| 4 | surfaced as `rejected` | `op_rejected: 0`, `sync_disabled: 1` | **never happens** |
| 5 | none accepted | nothing accepted | **holds — shipped here (with a positive control)** |

2 and 4 are unreachable for three independent spec-level reasons (401 at the middleware precedes `pipeline.ts:91`, which is normative per api/02-auth §8/§9; the client marks ops only from a 200; and "kept" contradicts §7.3's by-design wipe). Building them anyway would let one spurious 401 permanently destroy unsynced work — `rejected` is terminal. **Full detail and the decision live in task 70.**

**Shipped:** `packages/core/test/sync/offline-revocation.test.ts` — behaviours 1/3/5 + the positive control §218's "none accepted" is meaningless without. Falsified both ways: gutting `isDeviceRevoked` turned the kept/surfaced test red (`expected +0 to be 1`) while the control stayed green; gutting accepted-marking turned the **control** red (`expected 'rejected' to be 'synced'`) while the other two stayed green — so "none accepted" is not passing vacuously. Product source restored to an empty diff both times.

**The id is NOT titled here** — that would be this very task committing instance #18.

### 3. Ownership as landed

| id | resolution |
| -- | ---------- |
| `SEC-DEV-04` | allowlist → **task 70** (spec conflict must resolve before the id can be retired) |
| `SEC-DEV-05` | allowlist → **task 26**; 26's marker declares it. Its `FaultFetch` wrapper is the only surface that sees every outbound request, which is what §219 requires |
| `SEC-DEV-07` | allowlist → **task 70**. 17th instance: `13:63` disclaims its CHAIN_BROKEN leg to task 07 **in prose**, and `07:55` claims only `SEC-OPLOG-01..09` — pointed at a task that never accepted it |
| `SEC-AUTH-06`, `SEC-AUTH-11` | marker → **task 14**, transcribing the claim `14:45` already makes in prose. Task 54's decision (1) — whether the *title* should move to 07, which completes them — is **untouched and still open**, but the pair is no longer invisible |

`sec-dev.test.ts`'s three partial-leg titles now carry their ids in a **comment** (§2.1.6), following `sec-sync.test.ts:66`.

### 4. Out-of-scope findings — filed, not fixed

- **Malformed ownership markers are invisible unless allowlisted.** `parseOwnedIds` correctly returns `malformed`, but `auditSecCoverage` only consults `malformedMarkers` for ids that *have an allowlist row*. Tasks **58, 59, 60** all carry `**SEC ids owned by THIS task:** —` (an em-dash plus prose) — malformed, silently ignored, declaring nothing. Not fixed here (they are other tasks' files, and making it fatal would fire on three tasks in flight). This is the "silently checks nothing" mode inside the very gate built to prevent it.
- **Task-file `Status:` has drifted from `_index.md`.** 07/13/15 say `in-review`; the index says `done`. The gate's `staleAllowlist` reads the **task file**, so a stale row pointing at an index-done task would not fire. §2.6 says the index is canonical.
- **`pipeline.ts:91` is reachable only from a test** (`pipeline.test.ts:262` calls `processPushBatch` directly). Sound as defence-in-depth; must not be cited as SEC-DEV-04's producer. Recorded in task 70.

## The finding (task 54's class sweep, 2026-07-15)

Task 54 was filed to close SEC-AUTH-06/11's server legs. Those legs turned out to already ship (task 07). **The sweep it mandated found the real instances of the class two ids over.**

| id | shipped title | the leg the guide requires that nobody ships |
| -- | ------------- | -------------------------------------------- |
| `SEC-DEV-04` | `apps/server/test/security/sec-dev.test.ts:157` — *"**SEC-DEV-04 (server leg)** revoked-device 401: every identity endpoint returns DEVICE_REVOKED …"* | §218: *"Revoked-while-offline device **continues local operation**; on reconnect, all queued ops → `DEVICE_REVOKED`, **kept + surfaced as `rejected`**, none accepted"* — the offline-continue + queued-ops client leg |
| `SEC-DEV-05` | `apps/server/test/security/sec-dev.test.ts:173` — *"**SEC-DEV-05 (server leg)** private key never reaches the server: EnrollReq is .strict() …"* | §219: *"Enrollment request payload, **sync bodies, and logs** contain no private-key material (**harness intercepts all outbound requests** during enroll + sync cycle)"* — the outbound-interception leg |

**Both titles embed the id verbatim, so SEC-META-01 reads each id as fully shipped.** Neither has an allowlist row. The gate is green.

### The disclaimer exists — in prose, which is exactly what cannot hold ownership

`13-auth-server.md` **states both gaps accurately and in detail**:

- line 60: *"… the **offline-continue + queued-ops client leg lands in tasks 14/16 and re-runs in 28**."*
- line 61: *"… **full outbound-interception leg is harness-owned (26/28)**."*

Verified 2026-07-15, mechanically:

- `git grep "SEC ids owned by THIS task" ai-docs/tasks/*.md | grep SEC-DEV` → **no marker declares any SEC-DEV id.** Not 14, not 16, not 26, not 28.
- `grep "SEC-DEV-04|SEC-DEV-05" packages/test-support/src/sec-pending-allowlist.json` → **no row.**

So the legs are pointed at four tasks by prose and owed by none of them. This is task 31's thesis reproduced exactly — *"prose cannot express ownership; a grammar can"* — and CLAUDE.md §2.11's newest entry: **the comment was the guard.** Task 13's disclaimer is accurate, specific, and names the exact owing tasks; it is also load-bearing on nothing, and its authority is precisely what stopped anyone checking.

## The orchestrator traced SEC-DEV-04's client leg to its producer. It is genuinely unshipped — but read HOW, because the near-miss is the point.

Task 54's premise died because its filer (the orchestrator) read task 31's **title audit** and inferred "not titled ⇒ not shipped". The legs were shipped — by task 07, under titles carrying no id. **Do not repeat that here in the other direction.** Before declaring a leg unshipped, trace it to a producer.

Done for SEC-DEV-04, and it survived. `grep device_revoked` over the client tests returns hits that look like coverage and are not:

| hit | what it actually asserts | discharges §218? |
| --- | ------------------------ | ---------------- |
| `core/test/sync/state-and-devices.test.ts:236/251` — `syncDisabledReason: 'device_revoked'` | a **SyncState round-trip**: the field persists and reads back. It merely *uses* the enum value. | **no** |
| `core/test/sync/loop.test.ts:137-165` — `device_revoked` transitions, *"expressible from EVERY state"* | the state machine **accepts the event** from any state | **no** |
| `apps/mobile/src/screens/rejection-keys.test.ts:37` | a label key exists for the code | **no** |

§218 requires: revoked-while-offline **continues local operation**; on reconnect **queued ops → `DEVICE_REVOKED`**, **kept** (not deleted), **surfaced as `rejected`**, **none accepted**. Nothing above asserts any of those five. **The leg is open.**

**The lesson, and it cost two near-misses in one hour:** a *mention* is uncorrelated with existence **in both directions**. A comment mentioning `canAttempt` made a dead function look alive (task 60); an untitled test in task 07 made live behaviour look dead (task 54). Grep answers *"is this string here?"*, which is never the question. **Trace to a producer** (task 52's Note, which the orchestrator wrote and then broke twice).

## Why the gate cannot see this (do not "fix" it by deleting the title)

Task 31's `titledButPending` fires when an id is *both* titled and allowlisted. Here **no row exists**, so there is nothing to contradict — 31's stated residual (*"Can a partial-coverage title still claim an id? Yes — when no row exists"*), live for the 15th and 16th time.

Retiring an id needs title→task attribution the gate does not have. **Do not repoint by editing titles alone** — an id is retired by a title, so renaming without shipping the leg moves the hole rather than closing it (task 54's warning, still binding).

## Decide first (red-flag call — CLAUDE.md §6)

**Who owns each client leg?** Record in `decisions/`:

- `SEC-DEV-04` offline-continue + queued-ops-kept-as-`rejected` — task **15** (sync-client) already ships the neighbouring `SEC-SYNC-02` client leg (`packages/core/test/sync/push.test.ts:258`), which asserts *"ops pushed in the revocation window come back DEVICE_REVOKED and are kept client-side as rejected"* — **materially the same assertion**. Decide whether SEC-DEV-04's client leg is discharged by that, is a duplicate of it, or is genuinely distinct (the *offline-continue* half has no counterpart there and appears uncovered). Do not assume; read both.
- `SEC-DEV-05` outbound interception (sync bodies + logs) — task **26** (chaos harness) or **28**; it needs a request-intercepting harness, which is 26's surface.

## The correct pattern already exists in-repo — copy it, don't invent

`apps/server/test/integration/sync/sec-sync.test.ts:66` ships SEC-SYNC-02's **server** legs under the title *"revoked device rejected (server legs — see the comment above for the surface id)"* — id in a **comment**, deliberately **not** in the title, so the client-leg owner keeps the claim. That is security-guide §2.1.6 followed correctly, and it is why SEC-SYNC-02 is *not* on this list despite having the same two-leg shape.

## Acceptance

- Each id is either **fully shipped** (every leg in its guide row, titled by the task that *completes* it) **or** carries an allowlist row naming an owner whose `**SEC ids owned by THIS task:**` marker declares it. No id may be titled by a partial leg with no row — that is the whole defect.
- Contributing surfaces (e.g. task 13's server legs) reference the id in a **comment**, never a title (§2.1.6), following `sec-sync.test.ts:66`.
- **Falsify before believing** (§2.11): break the leg you ship, watch that specific test go red, restore, report as *"broke X, saw Y fail, reverted"*. Never *"the test passes"*.

## Note — the sweep's real lesson

Task 54 hunted two ids that were **already closed** and, in doing so, surfaced two that are **open**. The audit trail said SEC-AUTH-06/11 were the instances; the files said otherwise. Every one of the now-sixteen instances of this class was found by a human reading files, and **not one by the gate** — including this pair, found only because task 54 was told to sweep the class rather than fix the instance (testing-guide T-12).
