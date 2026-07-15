# TASK 31 — SEC-META-01 cannot tell "owns" from "disclaims"; three rows are armed
**Status:** in-review
**Depends on:** 03

## Outcome (2026-07-15) — shipped

Ownership is now **declared and parsed**, never inferred from prose. `packages/test-support/src/sec-meta.ts`:

- **The marker.** `**SEC ids owned by THIS task:** SEC-RT-01..05, SEC-SECRET-01` — or `none`. Strict grammar: a comma-separated list of ids/inclusive ranges, no trailing prose. This formalizes the line tasks 14/15/16 were already hand-writing under duress; it was not invented here. **Ranges are first-class**, so task 15/26's `SEC-SYNC-01..10` is now a claim the gate can read.
- **Malformed ⇒ loud, not empty.** A marker that violates the grammar returns `malformed`, never a zero-id claim — the "silently checks nothing" failure mode of CLAUDE.md §2.11.
- **Exactly one owner per id** (`ownershipConflicts`). This is what catches the update-(d) inversion: a *stale claim* in one file and a correct disclaimer in another are now a visible conflict rather than invisible agreement.
- **`titledButPending`** — an id that is both titled by a test and listed as owed fails. The row says "owed", the title says "shipped"; they cannot both be true. This is the partial-coverage detector, and it needs no title→task attribution.
- **Comments are stripped before titles are extracted.** Found live: `\bit\s*\(` matched the *English word* "it" in `apps/server/test/integration/oplog/sec-oplog-07.test.ts`'s prose — *"does NOT title **it (**"SEC-OPLOG-07 …")"* — so a **comment was being read as a shipped test title**. That is CLAUDE.md §2.11's first listed defect (title-vs-content) alive again, in a third direction nobody had looked for.
- **Denominator asserted** (T-14): the gate reports `{ids, titles, taskFiles, declaredIds}` and fails below floors. Measured: **56 ids · 1856 titles · 162 tracked test files · 54 task files · 9 declared ids**. The `git ls-files` walk is retained — a filesystem walk would sweep sibling worktrees.

**Timing — fixed.** A wrong owner no longer waits for the `done` flip. `badOwners`, `titledButPending` and `ownershipConflicts` are all status-independent, so a bad row fails **the moment it is written**. Falsified on real data: pointing `SEC-RT-01` at task 03 (`Status: in-review`, *not* done) fires `badOwners` immediately. `staleAllowlist` stays as the backstop.

### The audit — 56 ids, every one verified against its task file and the security-guide

Not taken from the task table on trust; the table was **stale**. The "three armed rows" (SEC-OPLOG-02/05/09) no longer exist — repointed and shipped by tasks 07/15 before this task ran. Live state was 46 titled / 10 pending. **Eight of ten rows were correct** (SEC-AUTH-09→28, SEC-AUTH-10→27, SEC-TENANT-04→28, SEC-SECRET-01→28, SEC-RT-01/02/04/05→20). Two were wrong — **both found by reading, neither by the gate**:

| id | was | now | why |
| -- | --- | --- | --- |
| `SEC-MEDIA-01` | 18 (pending) | **row removed** | `18-media-client.md:64` **disclaims** it ("they ship with task 19, not here… No SEC-* id may be marked done by this task"). Task 19 owns `SEC-MEDIA-01..06` (`19:48`) and shipped **both** titles, which match §7.2's full definition. The id is shipped; the row was a dead pointer at a disclaimer — instance **eleven** of the original bug. |
| `SEC-RT-03` | 02 (pending) | **20** | `02-schemas.md:56` **disclaims** it ("none execute in this task — pure definitions, no runtime surface"); `20-realtime.md:50` claims the WS/SSE legs. Instance **twelve**. |

`SEC-RT-03` also carried a live **partial-coverage retire**: `packages/schemas/test/ws.test.ts:24` titled a *fixture* `(SEC-RT-03 fixture)`, which read as the id being fully shipped and silently retired task 20's WS/SSE audit **and** task 21's push leg. The id is now kept out of that title (task 16's discipline), with the reason in a comment.

### Can a partial-coverage title still claim an id? **Yes — when no row exists. Reported, not papered over.**

`titledButPending` closes the case where a row is live, which is every documented incident. It does **not** close the case where the row is already gone, because retiring an id needs title→task attribution the gate does not have. **This is live right now**, and the audit found it:

- **`SEC-AUTH-06` / `SEC-AUTH-11`** are titled `"… client arm …"` by task 14 with **no row**. security-guide §162/§167 give each a **server leg** (a forged `auth.pin_reset` op pushed anyway → `SCOPE_VIOLATION` at push). The client-arm title retires the whole id, so those server legs are **currently unclaimed and invisible** — the same shape task 14 caught in itself for SEC-AUTH-09 and task 16 did not for SEC-SYNC-02. Not fixed here (shipping server legs is tasks 13/16/28's surface, and 14/16 are in flight); filed as **task 54**.
- Multi-leg ids spanning tasks (`SEC-RT-03`/`SEC-RT-04` across 20 and 21) cannot be expressed as "retired only when both legs land". Ownership points at task 20, matching the convention the allowlist already used for SEC-RT-04. If task 21 later declares them, `ownershipConflicts` fires — which is the correct outcome: it forces an explicit decision instead of silent double-ownership.

The full closure is `covered(id) = titleExists(id) AND ownerDeclaresShipped(id)`, which needs a `shipped` marker on every owner of the 46 titled ids — ~15 task files, several in flight (14/15/16). Deliberately out of scope; see task 54.

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

**Update 2026-07-15 — the SEC-OPLOG tangle is wider than three rows, and two were repointed live.** A pre-emptive fix landed `SEC-OPLOG-05 → 07` (server hash-recompute, was wrongly on client task 06) and `SEC-OPLOG-09 → 15` (pull-side verify = sync-client, was on 06) to stop them detonating at task 06's merge. But the whole SEC-OPLOG allocation across the decompose is mis-scattered — task files 06 AND 07 both *mention* ids that only one owns, and the mention-based `badOwners` check cannot tell claim from disclaim (the core flaw this task fixes). Authoritative ownership (from the crypto review): 01/03/04/05/07/08 = server tamper validation → **07**; 02 = replay-idempotency → **07** (the authoritative property is server-side: the per-tenant serverSeq counter must not advance on replay; task 06's client dedup-by-id is a plain correctness test, not this adversarial id); 06 = RFC vectors → **03 (shipped)**; 09 = pull-side verify → **15**. This task's ownership-marker mechanism must be applied across ALL these files so each id has exactly one shipping owner and the gate verifies ship-not-mention. Do the full SEC-OPLOG (and SEC-AUTH, SEC-SYNC, SEC-MEDIA) audit here, not piecemeal. **SEC-MEDIA-01 (added 2026-07-15):** the allowlist points it at task 18 (media-client) but task 19 (media-server) SHIPS a `SEC-MEDIA-01`-titled test for the server-observable 409-on-re-init; both legs are real (server immutability + client attach-then-treat-409-as-success). An id that is simultaneously allowlisted-as-pending AND has a shipped test is exactly what the ship-not-mention gate must handle — split it or scope it so each leg has one clear owner.

Fix the gate so ownership is **declared**, not inferred from prose, and correct the three rows. Ownership must be a fact the task file states in a machine-checkable way — not something a substring match guesses at.

**Update 2026-07-15 (b) — the flaw has now been *demonstrated*, not just reasoned about, and two more rows surfaced.**

- **SEC-AUTH-06 was armed and is now defused** (found by task 09). The allowlist pointed it at **task 09**, whose file *disclaims* it — the exact mention-vs-ownership flaw, in the wild for the second time. Task 09 **proved the time-bomb before touching it**: it flipped its Status to `done` in a scratch run and watched `staleAllowlist` fire — *"SEC-AUTH-06 → 09 (task is done but the test never shipped)"* — then repointed the row to **task 14**, whose file explicitly claims it ("SEC ids shipped IN this task: … SEC-AUTH-06 (client arm)"), and re-ran the simulation green. That is the first time anyone has *watched* this gate detonate rather than predicted it, and it confirms the timing critique above: the blast lands on whoever flips the status, never on whoever introduced the row.
- **SEC-AUTH-11 is still ambiguous** (reported by task 09, deliberately not resolved): it sits on **task 10** while **task 14** also claims a "client arm". Same claim-vs-disclaim ambiguity, unresolved — resolve it in this task's audit.
- **Task 13 repointed SEC-RT-02 → task 20** (it was mis-mapped to 13; task 20's file ships it). Another pre-emptive defusal, same root cause.

**Update 2026-07-15 (c) — SEC-AUTH-11 was the sixth, and the resolution is now mechanical enough to state as a rule.** The allowlist pointed `SEC-AUTH-11` at **task 10**, whose file (line 41) says *"no named SEC/CHAOS id is owned by this surface… the command-layer denial legs of SEC-AUTH-06 / SEC-AUTH-11 … land with tasks 14/26/28"* — a disclaimer. Task **14**'s file (line 45) says *"SEC ids shipped IN this task, before review: … SEC-AUTH-11 (client arm)"* — a claim. Task 10 spotted it, correctly **left the row alone** (it had no mandate to edit another task's row mid-flight, §4), and verified no detonation at `in-review` by **running** the gate (58/58 EXIT=0) rather than reading its code. Repointed to task 14 by the orchestrator and re-verified by running the gate again. Note what the two files already contain: task 14 has a **"SEC ids shipped IN this task"** line and task 10 has an explicit roll-call disclaimer. **The declarative marker this task is meant to invent already exists by convention in the task files — it is just not what the gate reads.** That is the cheapest possible fix: parse the line that is already there.

**Update 2026-07-15 (d) — SEC-OPLOG-07 is the seventh, and it is the instructive inversion.** Here the *task file* was wrong and the **disclaiming file was right**. `packages/db-server/test/append-only.test.ts:5` states outright: *"SEC-OPLOG-07 is NOT titled here on purpose: security-guide §3.2 scopes it to the full rejection pipeline (task 07 owns it, per the SEC-META-01 pending allowlist)."* Task 05's file carries the stale claim; security-guide §3.2 scopes the id to the **full rejection pipeline** = task 07's surface, not task 05's DB-level facts. review-03 confirmed following the allowlist was right. **Why this one matters for your design:** the previous six were "prose mentions an id it doesn't own." This one is "prose *correctly disclaims* an id, and a stale task file claims it." A mention-based gate mishandles both — but ship-not-mention resolves both correctly, because it reads the *test titles that actually shipped*, and neither a disclaimer nor a stale claim is a shipped title. That is the strongest argument for the mechanism: it is indifferent to what the prose says, right or wrong.

**Tally: seven rows across six tasks (SEC-OPLOG-02/05/07/09, SEC-AUTH-06, SEC-RT-02, SEC-AUTH-11) were mis-pointed — every single one found by the task that would have been blamed, and not one by the gate.** Seven for seven. A gate whose defect rate is 100% against its own purpose, discovered exclusively by the people it would have punished, is not a gate; it is a tax on the honest. That is the argument for ship-not-mention, and for the timing fix: none of these seven would have fired until someone flipped a status to `done`, at which point the blast lands on whoever did the flipping.

**Update 2026-07-15 (e) — instance 10, and a NEW gate defect: `badOwners` cannot read RANGE notation, so a legitimate claim is invisible.**

Task 16 needed to point SEC-SYNC-02's client leg at its real owner and **could not**: tasks 15 and 26 both claim their ids as **`"SEC-SYNC-01..10"`** — a string that does **not literally contain** `SEC-SYNC-02`. `badOwners` does `taskText.includes(id)`, so the gate fired (`"task file never mentions the id"`) against a task that genuinely owns the behavior (`15-sync-client.md:51` — per-op `rejected` marking + surfacing). Task 16 falsified both directions before touching anything: drop the row → `missing: ['SEC-SYNC-02']` EXIT=1; row present + task 15 silent → `badOwners` EXIT=1. It then added a minimal, accurate **"SEC ids owed by THIS surface"** line to task 15 naming the id explicitly. **Approved** — task 15 is `todo` (no contention), and the gate provably required it.

**This is the inverse of the first nine and it matters to your design.** Those were *"prose mentions an id it doesn't own"* (a false claim the gate accepts). This is *"prose claims ids in a form the gate can't parse"* (a **true** claim the gate rejects). So `badOwners` is wrong in **both** directions — it accepts disclaimers and rejects ranges — which is the strongest possible argument that **substring-matching prose was never the right mechanism.** Note the shape of what task 16 had to do: it hand-wrote an explicit, machine-readable ownership line, which is precisely the declarative marker this task exists to build. **The convention is already emerging by hand; formalize it and parse it.** Enumerate every range-notation claim (`grep -nE 'SEC-[A-Z]+-[0-9]+\.\.[0-9]+' ai-docs/tasks/`) — each one is a task whose ownership the gate currently cannot see.

Also worth carrying: task 16 **caught itself re-introducing the id mid-fix** — its first replacement `describe` read *"…server legs of SEC-SYNC-02…"*, which still matched `includes()`. A gate keyed on substrings makes the *fix* for a false claim hard to write correctly, which is its own argument.

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

## Related generalization (2026-07-15, from task 46's review) — T-8's denominator is the wrong noun

This task is about a gate whose *matching rule* is wrong. Task 46's review found the sibling: a gate whose **scope** is wrong, and which therefore never claimed the ground it was assumed to cover.

**T-8 says: "every module's appliers run through the shared applier conformance suite against BOTH engines."** It does that faithfully. But `highestContiguousServerSeq` — the function whose int8 bug pinned the production watermark at zero forever — **is not an applier.** It lives in the pull branch (`engine.ts:154`), and applier-conformance calls only `engine.applyAppendedOp` (`_harness.ts:267`). So on the PGlite leg **the function was never executed**, by design, and no one noticed because the gate's name ("both engines") describes a *coverage* the reader infers and the *scope* nobody re-read.

**The generalization worth carrying into whatever mechanism you build here:** a gate's denominator must be stated in the noun the reader will assume. "Appliers covered" reads as "the engine is covered." **T-8's denominator should be *engine entry points exercised*** — with the unreached ones **named**, so absence is visible rather than inferred. That is the same demand this task makes of SEC-META (state ownership; don't infer it from prose), applied to the conformance gate.

Both gates fail the same way in the end: **they answer a question adjacent to the one everyone believes they answer.**
