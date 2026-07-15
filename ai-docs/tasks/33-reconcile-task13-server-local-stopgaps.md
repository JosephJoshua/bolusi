# TASK 33 — the shared-package stopgaps (tasks 13 and 09) must move to the shared packages
**Status:** todo
**Depends on:** 09, 13

## Goal

Task 13 (auth-server) built three things **inside `apps/server`** that do not belong there. Not carelessness — in each case the shared package was either off-limits to task 13 (contention, CLAUDE.md §4) or not yet built (task 09 was `todo` when task 13 ran). Task 13 flagged all three itself. They are stopgaps with a shelf life, and this task ends it.

The load-bearing one is a **direct CLAUDE.md §2.8 violation** — the hard rule names this exact case: *"One implementation, not per-module copies. Permissions / validation / shared logic live once, in shared packages."*

| # | What task 13 built locally | Where it belongs | Why it landed local |
| - | -------------------------- | ---------------- | ------------------- |
| 1 | `apps/server/src/identity/permission-registry.ts` (from `02-permissions` §11/§12, drift-guarded against the DB seed) | `@bolusi/core` — **task 09 is the registry owner** | task 09 was `todo`; task 13 needed a registry to seed + validate against |
| 2 | `apps/server/src/identity/schemas.ts` (auth DTOs) | `@bolusi/schemas` | `@bolusi/schemas` had no auth DTOs and was off-limits to task 13 |
| 3 | surface error codes emitted via a **per-handler envelope wrapper** | the `api/00` §7 error registry (`@bolusi/schemas`) | the registry lacks them |
| 4 | `packages/core/src/authz/denials.ts` — the `auth.permission_denied` payload **type + a hand-written structural validator** (task 09) | `@bolusi/schemas` — the Zod schema + payload type | `@bolusi/schemas` had no auth op registry and was off-limits to task 09 |

**It happened twice, which makes it a pattern rather than an incident.** Tasks 13 and 09 independently built local copies of shared-package artifacts, for the *same* structural reason: the shared package was contended or unbuilt, and the work could not wait. Both disclosed it; neither hid it. That is the decompose telling us something — see the Note at the bottom.

Task 09's instance in detail: it wrote the payload type **and a structural validator** in `core/src/authz/denials.ts`, with a comment saying it must be **deleted in favour of** the Zod schema when the auth op registry lands (explicitly not kept alongside — §2.8). Consequence to close here: task 09's acceptance line *"payload validates against the `@bolusi/schemas` shape"* is **unmet by construction** — the shape it validates against is its own. A hand-written validator and a Zod schema are two encodings of one contract; when they disagree, the op log is the thing that silently gets it wrong.

### What review-02 already established (2026-07-15) — read before you plan

The reviewer diffed the registry three ways on the merged branch and found **no drift today**:

| Source | ids |
| ------ | --- |
| `ai-docs/02-permissions.md` §11 (authority) | 19 |
| `apps/server/src/identity/permission-registry.ts` | 19 |
| `packages/db-server/migrations/0008` seed | 19 distinct |

`diff(code, doc)` → **identical**. `diff(seed, code)` → **identical**. So task 13's copy is a **verbatim transcription, not a fork**, and it carries an explicit ownership note naming task 09/31 and CLAUDE.md §2.8 — it disclosed the duplication rather than hiding it. Its drift guard is real and asserts its own denominator (`acting-user.test.ts`: `PERMISSIONS.length === 19`, `PERMISSION_BY_ID.size === 19`, plus a `selectFrom('permissions')` comparison of seed against code).

**This changes the shape of this task, not its necessity.** The reconciliation should be a mechanical import swap. The risk that remains is the one nobody could measure yet: **task 09's canonical `@bolusi/core` registry did not exist when that diff was taken.** The diff that actually matters — task 09's registry vs these 19 ids — is yours to run, and it is the first thing to do.

Reviewer's ruling to enforce: **task 14 (or whoever imports core's registry first) must DELETE this file, not leave both.** Two registries that agree today are not a §2.8 violation that resolved itself; they are one that has not fired yet.

**Why #1 is urgent and not cosmetic.** Two permission registries means two answers to "what permissions exist." They will drift, and the drift is silent: the server seeds + validates from its copy, the client evaluates from task 09's copy. A permission that exists in one and not the other is an authorization hole that no single-package test can see — the server would accept a command the client believes is ungranted, or vice versa. The whole fraud model rests on one registry (`02-permissions` §3-5). This is exactly the class of bug that only shows up across a boundary neither owner tests.

## Docs to read

- `CLAUDE.md` §2.8 (the rule this closes), §4 (why it landed local).
- `02-permissions.md` §11-12 (the canonical registry + permission ids), §3-5 (registry assembly, the single enforcement point).
- `api/02-auth.md` §10 (the auth error-code list), `api/00-conventions.md` §7 (the error registry + envelope).
- `ai-docs/decisions/2026-07-15-auth-lookup-security-definer.md` (D14) — context for why task 13's scope stretched.
- Task 09's shipped `@bolusi/core` registry — **the canonical one**. Read it before touching task 13's copy.

## Skills

- `superpowers:test-driven-development` — the drift test comes first (see Acceptance).
- `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `apps/server/src/identity/permission-registry.ts` — **deleted**, consumers repointed at `@bolusi/core`.
- `apps/server/src/identity/schemas.ts` — moved to `@bolusi/schemas` (or deleted if task 14 already moved it).
- `packages/schemas/src/**` — auth DTOs + the missing error codes. **Contended** (CLAUDE.md §4) — serialize; do not run while another agent holds `@bolusi/schemas`.
- `apps/server/src/**` — the per-handler envelope wrapper folds into the registry path.
- `api/02-auth.md` §10, `api/00-conventions.md` §7 — doc-first if codes are added.

## Acceptance

**Observable done-condition:** exactly one permission registry exists in the repo, `apps/server` imports it from `@bolusi/core`, and a test proves a registry drift between server and client is *impossible* rather than merely *absent today*.

- **The drift test comes first, and it must be able to go red** (CLAUDE.md §2.11 / T-11). Before deleting anything: write a test asserting the server's effective permission set == `@bolusi/core`'s. Then **falsify it** — add a permission to one side only, watch it go red, restore. A test that cannot distinguish the two registries is worthless here; that is the entire risk. **Assert the denominator** (T-14): the test enumerates every permission id, and fails if the count is zero or the registry failed to load — not just "no mismatches found" over an empty set (T-14b — the task-05 vacuity trap).
- **Then delete `apps/server/src/identity/permission-registry.ts`** and repoint every consumer (incl. the DB-seed drift guard) at `@bolusi/core`. The seed guard must still catch a seed/registry mismatch after the repoint — falsify it again post-move; a guard that silently stops guarding during a refactor is the "green for the wrong reason" pattern this repo keeps hitting.
- **Verify task 13's copy against `02-permissions` §11/§12 yourself before deleting it** — do not assume task 09's is a superset. If they diverge, the divergence is a **finding, not a merge conflict to resolve by preference**: report which is right per the spec and why. (Taking a table on trust is precisely what produced the bug task 31 exists to fix.)
- **Auth DTOs move to `@bolusi/schemas`** — unless task 14 has already moved them, in which case confirm and note it.
- **Task 09's `denials.ts` payload + structural validator collapse into the Zod schema.** Same discipline as the registry: **first** write a test that the hand-written validator and the `@bolusi/schemas` Zod schema accept/reject the *same* inputs — then falsify it (make one accept something the other rejects; watch it go red). Only then delete the hand-written one. Feed it the adversarial shapes, not just the happy path: missing `permissionId`, unknown `reason` outside the closed enum, extra properties, wrong types, null `scopeStoreId`, a negative `suppressedRepeats`. Two encodings of one contract disagree at the edges, never in the middle — and per `02 §7` this payload lands in the **op log**, which is append-only, so a wrong shape is not a bug you patch, it is a bug you have to fold over forever. When it's deleted, task 09's acceptance line ("payload validates against the `@bolusi/schemas` shape") becomes true for the first time — confirm that explicitly.
- **Error codes — decide, then do, and state the ruling:**
  - `LOGIN_IDENTIFIER_TAKEN` is emitted by task 13 but **absent from `api/02-auth` §10**. Either add it to the spec + registry (doc-first) or rename to an existing code. Do not leave an emitted code that no registry knows.
  - The other surface codes (`AUTH_INVALID_CREDENTIALS`, `ACTING_USER_INVALID`, `ENROLL_*`, `LAST_ADMIN_PROTECTED`) route through a per-handler wrapper because `api/00` §7 lacks them — fold them into the registry so the envelope is one path, not two.
  - **`SESSION_EXPIRED` is specified but never emitted** — task 12's `verifyToken` maps expired sessions to `AUTH_TOKEN_INVALID`, and task 13 followed the merged reality. **review-02 ruled that following task 12 is the RIGHT call**, on two grounds: one vocabulary rather than two, and a distinct expired-vs-invalid code is an **oracle for an attacker** (it confirms a token was once valid). So the default action is: **remove `SESSION_EXPIRED` from `api/02-auth` §10** and record why. Overturn this only with a stated reason — and if you do, the security argument must be answered, not ignored. Either way the spec and the code agree when this task closes.
- No behaviour change to the D14 auth-entry path — the SECURITY DEFINER functions and their tests are untouched. Re-run `pnpm test:rls` against real PG16.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green. **Read the output, not the exit code** (CLAUDE.md §2.1).

## Note

Tasks 13 and 09 each flagged their own stopgap rather than letting it pass as done — that is the behaviour we want, and it is why this task can be written precisely.

**But it happened twice in one wave, and that is the finding.** Both agents hit the same wall: they needed an artifact from a shared package that was either contended (CLAUDE.md §4) or unbuilt (`todo`), and neither could wait. So each forked a local copy. **When task B needs task A's artifact and A is unscheduled or locked, B does not wait — it forks.** The duplication is not a discipline failure; it is what the dependency graph *forces* when a shared artifact is scheduled after its consumers.

Two things follow, both for the decompose:
1. **Shared contracts must land before their consumers, not beside them.** The permission registry (task 09) was scheduled after task 13, which needed it; `@bolusi/schemas`'s auth op registry is scheduled after both 09 and 13, which need it. That ordering guarantees forks.
2. **The forks are silent until someone looks.** Both were caught because the agents *volunteered* them. A less forthcoming agent produces the same duplication with no note, and §2.8 is violated invisibly until the two copies drift — and for the permission registry and the op-log payload, "drift" means an authorization hole and an append-only log full of wrong shapes.

Worth raising at the next decompose: any artifact named in §2.8 (permissions, validation, shared types/contracts) should be a **dependency edge**, not a parallel task.
