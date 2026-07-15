# TASK 61 — SEC-DEV-04/05's client legs are retired by a "(server leg)" title: the same class task 54 was filed for, still open

**Status:** todo
**Priority:** **HIGH** — these are **live holes with a green light over them**. Unlike task 54's ids (whose server legs turned out to be shipped — see 54's Outcome), the legs below are genuinely unshipped, unowned, and invisible to SEC-META-01.
**Depends on:** 31
**Blocks:** 28 (its roll-up assumes every SEC id is either titled or allowlisted)
**SEC ids owned by THIS task:** — (this task FILES the gap; it does not discharge either id. Do not claim SEC-DEV-04/05 here — deciding their owner is the first deliverable.)

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
