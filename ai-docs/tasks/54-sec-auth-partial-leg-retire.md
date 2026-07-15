# TASK 54 — SEC-AUTH-06/11's server legs are unclaimed and invisible: a "client arm" title retired the whole id
**Status:** todo
**Depends on:** 31

## Goal

Found by task 31's audit of all 56 SEC ids. **SEC-META-01 matches a title *containing* an id and reads that as the id being fully shipped.** Two ids are titled by a partial leg and have no allowlist row, so their remaining legs are retired — owed by nobody, visible to nothing.

| id | shipped title (task 14) | the leg security-guide requires but nobody ships |
| -- | ----------------------- | ------------------------------------------------ |
| `SEC-AUTH-06` | `packages/core/test/auth/pin-flows.test.ts` — *"SEC-AUTH-06 client arm — PIN command permission/targeting denials"* | §162: *"a forged `auth.pin_reset` op pushed anyway → rejected `SCOPE_VIOLATION` at push (api/02-auth §6.3)"*, plus *"by store owner → succeeds, audited `auth.pin_reset` op emitted"* |
| `SEC-AUTH-11` | `packages/core/test/auth/pin-flows.test.ts` — *"SEC-AUTH-11 client arm — privileged-target PIN reset (api/02-auth §6.6)"* | §167: *"A store_owner-signed `auth.pin_reset` op targeting the main-owner-role holder → rejected `SCOPE_VIOLATION` at push (05-operation-log §9)"* |

Both ids are **server-side push-rejection** legs. `10-command-layer.md:41` says so explicitly: *"the command-layer denial legs of SEC-AUTH-06 / SEC-AUTH-11 … land with tasks 14/26/28"* — task 14 shipped the command-layer arm; the **push** arm has no owner.

**This is the exact shape task 14 caught in itself and task 16 did not.** Task 14 spotted that a `SEC-AUTH-09 precursor —` title would have retired the real storage/push scan and renamed it. Task 16 shipped a `SEC-SYNC-02`-titled test for server legs it partly owned and silently retired the client leg — caught only by task 15. Nobody caught these two, because the gate cannot: with no allowlist row live, task 31's `titledButPending` rule has nothing to contradict, and closing it properly needs title→task attribution the gate does not have (task 31 §"Can a partial-coverage title still claim an id?").

## Decide first (this is a red-flag call — CLAUDE.md §6)

**Who owns the push legs?** Nothing here is a free choice; pick one and record it in `decisions/`:

- **Task 16 (sync-server)** — owns push rejection and `SCOPE_VIOLATION` (`SEC-SYNC-03` is the same machinery). Most likely correct.
- **Task 13 (auth-server)** — owns the auth surface but not the push pipeline.
- **Task 28 (security-sweep)** — already owns the ids no single surface can prove (SEC-AUTH-09, SEC-TENANT-04), and §52 already spot-checks *"the SEC-AUTH-11 semantics"* through the command layer. A spot check is **not** the §167 push-rejection leg — do not let the two be confused.

Do **not** repoint by editing titles alone: an id is retired by a title, so renaming without shipping the leg moves the hole rather than closing it.

## Docs to read

- `security-guide.md` §5 — the SEC-AUTH-06 (§162) and SEC-AUTH-11 (§167) rows, verbatim. These are the normative specs; the legs above are quoted from them.
- `security-guide.md` §2.1.5–2.1.6 — the ownership marker grammar and the partial-leg rule (landed by task 31).
- `ai-docs/tasks/10-command-layer.md:41` — the roll-call disclaimer that names 14/26/28.
- `ai-docs/tasks/14-auth-client.md:45` — the "SEC ids shipped IN this task" line; what the client arms actually cover.
- `ai-docs/tasks/31-sec-meta-ownership-gate.md` — the gate's mechanism and the stated residual. **Ride those rails; do not build a second ownership mechanism** (§2.8).

## Acceptance

- The push-rejection leg of **SEC-AUTH-06** ships: a forged `auth.pin_reset` op pushed by a device lacking `auth.user_reset_pin` → `SCOPE_VIOLATION` at push, never accepted; the store-owner positive control succeeds and emits an audited `auth.pin_reset` op (a non-vacuous control, T-14b).
- The push-rejection leg of **SEC-AUTH-11** ships: a `store_owner`-signed `auth.pin_reset` op targeting the `main_owner` holder → `SCOPE_VIOLATION` at push; a `main_owner`-signed reset of the same target succeeds (control).
- **Title discipline (security-guide §2.1.6):** only the task that *completes* an id embeds it verbatim. If these legs land in a different task from the client arms, the two tasks must not both title the id — decide which title is the claim and make the other a comment, or the id is retired twice over.
- Ownership is declared on the owning task's `**SEC ids owned by THIS task:**` marker, and `pnpm test` is green — including SEC-META-01's `ownershipConflicts`, which will fire if two files claim the id.
- **Falsify before believing** (§2.11): break the push check, watch the specific leg go red, restore. Report the falsification, never "the test passes".

## Note

Task 31's audit put the tally at **twelve** mis-pointed/mis-scoped rows, every one found by a human reading files and not one by the gate. These two are the thirteenth and fourteenth, and they are worse than the rest: the others were *wrong pointers* that something would eventually trip over, while these are **holes with a green light over them** — an id that looks shipped, in a suite whose whole purpose is to prove it is.
