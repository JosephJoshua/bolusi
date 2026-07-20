# TASK 37 — the store→tenant escalation guard is statement order, not structure
**Status:** in-progress
**Depends on:** 09

## Goal

Make it **impossible** for a malformed grant to reach scope matching, rather than merely **tested** that it doesn't.

**The mechanism today** (`packages/core/src/authz/evaluate.ts:124`): a store-scoped role carrying a null `grant.storeId` is dropped as malformed by a sequential `continue` **positioned before** the scope-match branch. Correctness depends entirely on that position.

**What it prevents — reproduced by review-02, not theorised.** With the drop removed and the evaluator rebuilt, the same malformed row produces:

| probe | result |
| ----- | ------ |
| malformed grant @ STORE_A | **ALLOW** |
| malformed grant @ STORE_B | **ALLOW** — widened into a store it was never granted |
| malformed grant → tenant-scoped permission | **ALLOW** — escalated store→tenant |

So one malformed row silently becomes **tenant-wide access**, on the single enforcement point the entire fraud model rests on.

**What protects it today, stated plainly** (review-02's honest answer to a direct question):
- ✅ The test **provably goes red**: removing the drop turns `evaluate.test.ts > "a store-scoped role granted with a null storeId is dropped as malformed (§5.2 step 5)"` red (1 failed / 92 passed). It is falsifiable, not decorative — T-11 satisfied.
- ⚠️ But it is **convention, not structure.** Nothing stops a future refactor from moving the `continue` below the scope-match branch, and doing so reintroduces the escalation exactly. The type system is indifferent; only the test objects.

**This is not a defect and task 09 merged on that basis.** It is a known property of a security-critical line, filed so it is a decision rather than an accident. Note the contrast worth preserving: the *neighbouring* invariant — "a store grant can never satisfy a tenant permission" — is structural (`tenantScope` and `storeScope` are separate sets; step 4 selects by the permission's scope), which is why nobody needs to remember it. The malformed-drop is the one place in this file where safety depends on a line's position.

## Docs to read

- `02-permissions.md` §5.2 (the evaluation algorithm; step 5 is the malformed-drop, step 4 the scope select).
- `packages/core/src/authz/evaluate.ts:124` (the drop) and its neighbours at :167-198 (the unconditional try/catch) — read the shipped code before proposing a shape.
- `packages/core/test/authz/evaluate.test.ts` — the test that goes red; it must still go red after your change (or be replaced by something stronger).
- `testing-guide.md` T-11, T-12; `CLAUDE.md` §2.5 (security is written, not reviewed in), §2.11.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `packages/core/src/authz/**` — **`@bolusi/core` is contended (CLAUDE.md §4)**; serialize, do not run beside another core agent.

## Acceptance

**Observable done-condition:** a malformed grant cannot be represented at the point of scope matching — moving or deleting a single statement in `evaluate()` can no longer reintroduce the escalation.

- **Reproduce the escalation first** (T-11 — do not fix what you have not watched break). Remove the drop, confirm all three ALLOWs above, restore. If you cannot reproduce it, stop and report; the premise is wrong.
- **Prefer parse-don't-validate.** The likely right shape: drop/normalize malformed grants when the **snapshot is built** (where the directory rows are lifted into memory), so `evaluate()` receives a type that cannot express "store-scoped role with null storeId" — make the illegal state unrepresentable rather than skipped. Then the guarantee is the type, and the `continue` disappears rather than moving. Justify whatever you choose; a different shape is fine if it removes the order-dependence.
- **The escalation test must still exist and still go red.** Structure replaces the *need* for the test; it does not replace the test. Falsify the new mechanism: construct a malformed grant, prove it cannot reach scope matching (compile error, constructor rejection, or an assertion at the boundary — say which), and prove the suite goes red if the new guard is removed.
- **Do not weaken the deny.** A malformed row must still result in a **deny**, not an exception that escapes the evaluator, and not a silent skip that widens anything. Keep the fail-closed contract: unrepresentable-at-evaluate must mean rejected-at-snapshot, never dropped-and-forgotten. Confirm the denial reason is unchanged for callers.
- **Re-run the full authz class sweep** (review-02's, in its task 09 report): scope leak, tenant-perm-via-store-grant, empty grants, unknown role, corrupt JSON, prefix/superstring/case/whitespace ids, `__proto__`/`constructor`, null/undefined storeId, deactivated user, tenant mismatch, unprimed snapshot. Every deny keeps its **positive control** (a valid grant in scope still ALLOWs) — a refactor that makes everything deny is not a fix, it is a bigger bug that looks like a pass (T-14b).
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Filed from review-02's task 09 review, which reproduced the escalation and then answered "structural or convention?" with **convention** rather than the comfortable answer. That honesty is the reason this task can be written at all — and it is worth noticing that the reviewer volunteered the weakness of code it had just approved. Priority is genuinely low: the guard works, its test goes red, and task 09 merged correctly. But this is the single authorization enforcement point, the failure is a *silent privilege escalation*, and the cost of the structural version is small. It is the difference between "we tested that nobody moved the line" and "the line cannot be moved."
