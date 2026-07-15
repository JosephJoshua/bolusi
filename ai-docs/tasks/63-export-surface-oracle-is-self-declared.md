# TASK 63 — `export-surface.test.ts` claims to check "exactly the documented set (08 §3.2)"; §3.2 documents no set, so the test is its own oracle

**Status:** todo
**Priority:** **LOW** — no live defect (verified). The test's list is currently correct and its sibling assertions are real. The defect is that the test cites a spec authority that does not exist, so the way to legalize an export is to edit the oracle.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none

## The finding (review-47, task 47 review)

`packages/db-server/test/export-surface.test.ts:1`:

```ts
// Task 05 acceptance (d): the package's public export surface is exactly the documented set (08 §3.2)
```

**`08 §3.2` does not document a set.** Its db-server row (`08-stack-and-repo.md:146`) is prose about a *property* — *"`forTenant(tenantId)` — the ONLY exported way to query tenant tables … The raw pool/db handle is not exported (migration runner excepted)"*. It enumerates nothing. It does not mention `createServerWatermarkStore` (task 47), nor the three D14 `SECURITY DEFINER` auth entry functions (task 13) — **so the drift predates task 47 and is not its fault.**

The test's own array **is** the "documented set" it checks against. That makes it self-referential: **you make a new export legal by adding it to the list the test reads.**

**Concrete scenario (review-47's):** an agent exports a new handle-producer under an unlisted name, the test goes red, the agent adds the name to the list, the test goes green — and the review sees a passing spec-conformance test. Nothing lied; the oracle simply had no independent authority.

**Why this is LOW and not HIGH — state it, so nobody gold-plates:** the sibling assertions are **not** self-declared and they are the ones carrying the real property. They explicitly name `db` / `pool` / `getDb`, and a `queryish` check catches anything exposing `selectFrom`. So the FR-1039 invariant (*`forTenant` is the only way to query tenant tables*) is genuinely fenced by tests whose oracle is the **shape of the thing**, not a list. Only the *"exactly the documented set"* claim is hollow.

## Acceptance

**Observable done-condition:** either the spec enumerates the surface and the test reads that, or the test stops claiming a spec authority it doesn't have.

- **Pick one and say which:**
  - **(a) Make §3.2 authoritative** — enumerate `@bolusi/db-server`'s real public surface there (incl. `forTenant`, `createServerWatermarkStore`, the D14 auth entries, the migration-runner exception), and have the test derive from it or cite it precisely. **Cost:** a doc that must be edited on every legitimate export — and a doc-vs-code drift gate is its own maintenance surface.
  - **(b) Drop the word "documented"** — the test asserts a **curated allowlist**, which is a legitimate and useful thing, and its comment should say exactly that: *"this list is the contract; adding to it is a deliberate act reviewed as such."* **Cost:** none, and it stops the citation implying an external check.
  - **The orchestrator leans (b)**, because (a) buys little: the load-bearing property is already fenced by the shape-based sibling tests, and an enumerated spec list would mostly duplicate the array while adding a second place to forget. But (a) is defensible if you judge the export surface to be a real contract — say why.
- **Do NOT weaken the sibling tests.** The `db`/`pool`/`getDb` names and the `queryish` check are what actually enforce FR-1039. This task touches a **comment and possibly a spec section**; if you find yourself editing an assertion, stop.
- **Check the class** (T-12): does any **other** test cite a spec section as its oracle where the section states a property rather than an enumeration? That is the reusable finding — *"a test that cites a spec that doesn't say what the test claims"* is unfalsifiable by every gate we have, and this repo has now found **five** instances of authoritative prose being wrong in one clause (T-15/T-16). Report; fix only what's trivial.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green — **read the output, not the exit code** (§2.1).

## Note

Found by review-47 while auditing task 47's move of `createServerWatermarkStore` into `packages/db-server` — not by looking for it, but by checking whether the move was legal against **the actual spec text** rather than the implementer's claim that it was. It verified `08 §3.3:164` genuinely grants `db-server → core, schemas, kysely, pg` (the move is legal, and it *removes* an `apps/*` coupling), and in doing so noticed the neighbouring test citing an authority that isn't there.

Worth carrying: this is the same shape as task 62 (`08 §5.6` prescribing a no-op) from the other end. **62 is a spec that says something wrong; 63 is a test that says the spec said something it never said.** Both are invisible to every gate, because no gate reads prose — and in both cases the prose is *citing a section number*, which is the single most effective way to stop a reader checking. A bare claim invites scrutiny; a claim with a citation closes it.
