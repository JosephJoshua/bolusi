# TASK 31 — SEC-META-01 cannot tell "owns" from "disclaims"; three rows are armed
**Status:** todo
**Depends on:** 03

## Goal

The SEC pending-allowlist gate has a structural flaw and three live wrong rows. Task 03 found it by asking a question nobody had asked: *does this gate distinguish owning an ID from mentioning one?*

**The flaw.** `badOwners` validates an allowlist entry by checking `taskText.includes(id)` — **mention, not ownership**. Task 03's file mentioned `SEC-OPLOG-01` and `SEC-AUTH-01` *precisely to disclaim them* ("that's task 07's / task 14's"), which satisfied the check perfectly. The gate cannot tell "I own this" from "I am telling you someone else owns this."

**The timing makes it worse.** `staleAllowlist` only fires when the owning task's status flips to `done`. So a wrong owner is invisible for that task's entire life and detonates on whoever flips the status — never the person who introduced it. Exactly what happened: task 03's `in-review` flip was safe; the orchestrator's `done` flip would have been the trigger. A gate that blames the wrong person, late, is a gate people learn to route around.

**Three rows are armed right now** (found by task 03; deliberately not fixed there — editing other tasks' rows mid-flight is CLAUDE.md §4 contention):

| id | allowlist says | task files say |
| -- | -------------- | -------------- |
| `SEC-OPLOG-02` | task 06 | `07-oplog-server.md:55` ships it |
| `SEC-OPLOG-05` | task 06 | `07-oplog-server.md:55` ships it |
| `SEC-OPLOG-09` | task 06 | task 07's file says task 15 |

None are armed by task 03's merge (their owner isn't task 03), but all three detonate on whoever flips task 06 to `done`.

**Update 2026-07-15 — the SEC-OPLOG tangle is wider than three rows, and two were repointed live.** A pre-emptive fix landed `SEC-OPLOG-05 → 07` (server hash-recompute, was wrongly on client task 06) and `SEC-OPLOG-09 → 15` (pull-side verify = sync-client, was on 06) to stop them detonating at task 06's merge. But the whole SEC-OPLOG allocation across the decompose is mis-scattered — task files 06 AND 07 both *mention* ids that only one owns, and the mention-based `badOwners` check cannot tell claim from disclaim (the core flaw this task fixes). Authoritative ownership (from the crypto review): 01/03/04/05/07/08 = server tamper validation → **07**; 02 = replay-idempotency → **07** (the authoritative property is server-side: the per-tenant serverSeq counter must not advance on replay; task 06's client dedup-by-id is a plain correctness test, not this adversarial id); 06 = RFC vectors → **03 (shipped)**; 09 = pull-side verify → **15**. This task's ownership-marker mechanism must be applied across ALL these files so each id has exactly one shipping owner and the gate verifies ship-not-mention. Do the full SEC-OPLOG (and SEC-AUTH, SEC-SYNC) audit here, not piecemeal.

Fix the gate so ownership is **declared**, not inferred from prose, and correct the three rows. Ownership must be a fact the task file states in a machine-checkable way — not something a substring match guesses at.

## Docs to read

- `security-guide.md` — §2.1 item 4 (SEC-META-01's mandate: a verbatim-ID **test title** must exist, or an allowlist entry naming the owner).
- `ai-docs/tasks/03-crypto-canonical.md` — §Acceptance, the disclaim lines (39, 41) that satisfied `badOwners` while denying ownership. This is the reproduction.
- `ai-docs/tasks/07-oplog-server.md` §Acceptance (line ~55) and `ai-docs/tasks/14-auth-client.md` §Acceptance (lines ~38, 45) — the true owners.

## Skills

- `superpowers:test-driven-development` — the negative test comes first: an allowlist row whose "owner" file only *disclaims* the id must FAIL. It currently passes.
- `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `packages/test-support/src/sec-meta.ts` — the ownership check.
- `packages/test-support/src/sec-meta.test.ts` — negative tests.
- `packages/test-support/src/sec-pending-allowlist.json` — the three rows.
- `ai-docs/tasks/06-oplog-client.md`, `07-oplog-server.md`, `15-sync-client.md` — only if a task file must carry an explicit ownership marker. **Serialize:** do not run while 06/07/15 are in flight.
- Possibly `security-guide.md` §2.1 — if the ownership declaration becomes normative.

## Acceptance

**Observable done-condition:** an allowlist row pointing at a task that merely *mentions* the id fails the gate, and `pnpm test` is green with the three rows corrected.

- **The reproduction is a test:** reconstruct task 03's exact shape — an allowlist row whose owner file names the id only to disclaim it — and assert the gate **fails**. It passes today; that test is the whole point of this task.
- Ownership is declared explicitly, not inferred. Suggested: the owning task file carries a machine-readable marker (e.g. a `SEC ids shipped IN this task:` line the gate parses), and `badOwners` requires the id to appear *there*, not anywhere in the prose. Whatever mechanism you choose, a disclaiming mention must not satisfy it.
- The three rows are repointed: `SEC-OPLOG-02` → 07, `SEC-OPLOG-05` → 07, `SEC-OPLOG-09` → 15 (**verify each against the task files yourself — do not take this table on trust; that assumption is what produced the bug**).
- **Timing:** decide whether a wrong owner can be caught before the `done` flip, and either implement it or state plainly why not. A gate that only fires on status change punishes the wrong person at the worst moment. If the check can run on every allowlist edit, it should.
- Existing negative tests still pass (comment-only mention → missing; untracked decoy ignored; malformed owner path → badOwners).
- `pnpm test` and `pnpm lint` green.

## Note

This is the fourth gate this project has shipped that looked green for the wrong reason (after: SEC-META-01's title-vs-content match, the codegen-diff gate made unsatisfiable by prettier, and the boundary rule's platform-free hole). The pattern is consistent enough to state as a rule: **a guard is only load-bearing if someone has watched it go red.** Every check in this task must be falsified before it is believed.
