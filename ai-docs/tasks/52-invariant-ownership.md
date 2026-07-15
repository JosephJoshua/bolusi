# TASK 52 — 8 of 12 live invariants have no owner and no test, in a section titled "Invariants (testable, numbered)"
**Status:** todo
**Priority:** MEDIUM — none is known-broken; all are **unverified universal claims** in a section that promises testability. Per D15b they are contracts, not provenance.
**Depends on:** 31

## Goal

Give every live invariant in `01-domain-model.md §10` **one owner and one test** — and state in the specs what `FR-####` citations actually mean (D15a), so nobody infers a traceability contract that doesn't exist.

## The finding (QA sweep, 2026-07-15 — see `decisions/2026-07-15-fr-ids-are-provenance-invariants-are-contracts.md`)

`01-domain-model.md §10` is titled **"Invariants (testable, numbered)"**. That title is a promise. Measured against it:

| | count |
| --- | --- |
| invariants numbered | 13 |
| live (I-12 is explicitly *"Retired"* — its absence is **correct**) | **12** |
| cited in **code** | **1** (I-6) |
| cited in a **task** only | **3** (I-7 / I-8 / I-11) |
| **neither** | **8** |

**"Neither" means untraceable, not unbuilt** — the sweep spot-checked and several are demonstrably enforced, just never linked:

| invariant | actually enforced by | id cited? |
| --------- | -------------------- | --------- |
| I-3 "last admin cannot be deactivated → `409 LAST_ADMIN_…`" | `core/src/errors/domain-error.ts:24` + i18n; task 13 owns the behaviour | **no** |
| I-9 "loginIdentifier globally unique across tenants" | `0004_identity_directory.ts:15` — `login_identifier text UNIQUE` | **no** |

So this is mostly **linking work**, not building work — but the link is what makes the claim checkable, and a universally-quantified claim with no test is exactly this project's signature failure: **it fails by being absent, and absence is invisible to every test we have.**

**I-13 is the instructive case, and it is already closed — read it first, it shows the shape.** *"PIN hash material never appears in the operation log or any op payload"* is **universal**. Task 14 proves it **per-case** (`pin-flows.ts` emits exactly `{targetUserId, verifierRef}`; its tests assert verifier-free payloads). The **universal scan over every pushed payload** is SEC-AUTH-09's push-scan leg — orphaned until it was repointed to **task 28** (verified: the allowlist now reads `"SEC-AUTH-09": "ai-docs/tasks/28-security-sweep.md"`). **Per-case ≠ universal.** That gap is what this task is looking for in the other eight.

## Docs to read

- `ai-docs/decisions/2026-07-15-fr-ids-are-provenance-invariants-are-contracts.md` — **D15, the ruling this task implements.** Read it first; it explains why invariants get this treatment and FRs deliberately do not.
- `01-domain-model.md` §10 — the 13 invariants and the promise in the section title.
- `packages/test-support/src/sec-meta.ts` + `sec-pending-allowlist.json` — **the mechanism to reuse.** SEC-META-01 already does exactly this shape for SEC ids: parse the spec for ids, require a shipped test title per id, allowlist the pending ones with a named owner.
- `ai-docs/tasks/31-*.md` — **read before designing anything.** SEC-META is currently wrong in **both** directions: it accepts a task that *disclaims* an id (10 mis-pointed rows), and it *rejects* legitimate claims written as ranges (`"SEC-SYNC-01..10"` contains no literal id; **10 task files use range notation**). Task 31 lands the declarative-ownership marker. **Ride those rails; do not build a second set** (§2.8).

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `ai-docs/01-domain-model.md` §10 (owner column), `ai-docs/tasks/*.md` (ownership markers), `packages/test-support/` (the gate — **coordinate with task 31**, same file).
- Wherever the missing invariant tests belong — likely spread across packages. **Serialize with 31.**

## Acceptance

**Observable done-condition:** every live invariant has exactly one owning task and a test whose title carries its id — and the gate fails when one doesn't.

- **Re-derive the denominator yourself** (T-14). The sweep says 13 numbered / 12 live / 8 unowned. **Do not take it** — a denominator on this project has been wrong three times (18 vs 21; 70 vs 67 vs the true 65; and the sweep's own first FR count was **31 vs the real 578**, because `git ls-files 'ai-docs/**/*.md'` matched 61 files and **silently skipped every top-level spec**). Confirm I-12 is genuinely retired before excluding it.
- **Per invariant, decide and record**: which task owns it, and does a test assert it? For the ones already enforced (I-3's `409`, I-9's `UNIQUE` index), the work is **citing the id in the test title** — not rebuilding the check. Don't gold-plate what's already true; make it *findable*.
- **Watch for per-case-vs-universal** (the I-13 shape): an invariant says *never* / *always*. A test proving one call site doesn't discharge it. Where a universal scan is genuinely needed, say so and give it an owner — that's what SEC-AUTH-09 → task 28 did.
- **The gate is the deliverable, and it must fail** (§2.11): remove an invariant's test title → red; restore → green. **Assert its own denominator** (T-14): it names how many invariants it checked and fails loudly on zero. A gate that silently checks nothing is the failure this repo has shipped **eight** times.
- **Do not repeat SEC-META's two bugs.** Ownership is **declared and parsed**, never inferred from prose (a file *mentioning* an id is not owning it), and the parser must handle however the claim is actually written — `badOwners` rejects range notation today and ten files use it.
- **The doc half (D15a):** state in the specs that `FR-####` is **provenance** — a pointer to the PRD that motivated the rule — that the **spec text is the requirement**, and that tasks discharge **spec sections**, not FR ids. 63 spec citations currently imply a contract that does not exist; that inference is the defect. **Do not build FR traceability** — D15a rules it out explicitly, with reasons.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

This is the **first** finding to come from asking *"what does the spec promise that nothing checks?"* rather than *"does this code work?"* — and the split it produced is the interesting part. The same sweep found **68 FRs** with no owner and **8 invariants** with no owner, and those are **not the same problem**: FRs are inherited from PRDs that CLAUDE.md itself calls stale input, while invariants are spec-native and explicitly promised testable. Ruling both the same way would have been wrong in one direction or the other — 68 items of archaeology for FRs, or 8 unverified universal claims left standing.

Worth carrying: the sweep's method — **trace to a producer, don't count mentions** — is what makes this checkable. Its own control proved why: mention-counting reported `restriction_violated` (the **dead** member) at 3 hits, *more* than `not_granted` (live) at 2. **The dead member looked more alive than the live ones.**
