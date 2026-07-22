# TASK 141 — two security-surface questions that need a RULING, not code: the push-token existence oracle contradicts a normative "only", and any device may write into any store of its tenant

**Status:** todo
**Priority:** MEDIUM — neither is a bug against the code as specified; both are places where the code and the spec disagree about what is allowed. CLAUDE.md §6 makes these owner decisions, not implementer choices.
**Depends on:** 118, 105
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA adversarial sweep, 2026-07-22.

## Question 1 — `POST /v1/push/tokens` is a cross-tenant existence oracle (introduced by task 118)

`apps/server/src/routes/push.ts:100`. Reproduced: tenant A registers token T → `200`; tenant B registers **T** → `403 PERMISSION_DENIED`; tenant B registers a **fresh** token → `200`. `held→403 vs fresh→200 DISTINGUISHABLE`.

`security-guide.md` §2.2 says "Existence is never confirmed across a tenant boundary" and declares the media id-keyed probe **"the only v0 exception"**. This is a second, undocumented one, and the confusion set is empty (the other 403 leg — cross-device — is something the caller knows it did not do).

**Mitigating:** an Expo token carries ~88 bits, so this confirms a token you already hold rather than enumerating one. That is a real argument, and it is the same argument the media exception already makes.

**The ruling needed:** document a §2.2 exception with the entropy argument (mirroring the media one), or make the response indistinguishable. Today the code contradicts a normative "only" — that is the part that must not stand either way.

*Related, not a finding on its own:* the cross-device 403 at `push.ts:38-40` returns **before** the 30/day `enforce(...)` at `:44-53`, so 35 denied attempts consumed no budget and a legitimate registration afterwards still returned `200`. Bounded by the app-level 120/min per-device limiter. Fix while you are there if the ruling touches this route.

## Question 2 — a device may push into any store of its tenant

HTTP-E: a store-1 device's op scoped to store 2 is **accepted** and pokes store 2. This is **05 §9.2 as written** — there is no device↔store equality rule — so the code is correct and the spec is what is under question. But notes are store-scoped (01 §9), so a mechanic at one branch can write a repair note into another branch's book.

**The ruling needed:** either (a) confirm this is intended for v0 (multi-branch staff share a device / cover other branches) and write the rationale into `05-operation-log.md` §9.2 + `security-guide.md` so the next sweep does not re-file it, or (b) add a device→store scope rule, which is a permission-matrix change and therefore a §6 red flag requiring its own task.

## Deliverable
A dated entry in `ai-docs/decisions/` recording both rulings, plus whatever doc or code change each ruling implies. **Do not silently pick the convenient answer** — if the ruling is "as-is", the deliverable is the written rationale, because an undocumented exception is what made both of these findable.
