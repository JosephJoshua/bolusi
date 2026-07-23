# TASK 141 — two security-surface questions that need a RULING, not code: the push-token existence oracle contradicts a normative "only", and any device may write into any store of its tenant

**Status:** in-progress
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


---

## OWNER RULINGS 2026-07-22 (D22)

- **Question 1 (push-token oracle): DOCUMENT AS AN ALLOWED §2.2 EXCEPTION.** Keep task 118's 403 fail-closed behaviour; amend `security-guide §2.2` to enumerate BOTH the media-id probe AND the push-token registration as allowed v0 existence exceptions, each with the ~88-bit-entropy rationale (confirms a token you already hold, never enumerates), and correct the "only v0 exception" wording. Reconcile any gate/test that treats the push-token 403 as a §2.2 violation to the documented decision. **This half stays on task 141 (141a).** It is a doc/spec change (CLAUDE.md §4) — implement + light review.
- **Question 2 (cross-store writes): ADD A DEVICE→STORE SCOPE RULE.** Spun out to **task 157** (a permission-matrix change, §6, with adversarial tests). This task no longer owns the cross-store question.

**Remaining scope of 141 = 141a only** (document the token-oracle exception). Close 141 when the §2.2 amendment lands and its guard is reconciled.

---

## FOUND BY 141a's SWEEP, RULED IN D23 §2 — `POST /v1/media/:id/init` is a third existence distinguisher, and it gets REMOVED (not documented)

141a's new SEC-TENANT-04 control leg (every endpoint's cross-tenant id vs an id existing nowhere must be indistinguishable) found **one** endpoint outside the two documented exceptions that distinguishes: `POST /v1/media/:id/init` answers `404 MEDIA_NOT_FOUND` for a media id **another tenant already holds** and `200` for a **free** id. Reproduced by the sweep; every other endpoint's pair is byte-identical modulo `requestId`.

This is *not* the `500` defect commit `d12face` fixed — that one is gone.

### The ruling — D23 §2: tenant-scope the media id

**Uniqueness becomes `(tenant_id, id)` instead of global**, so an id another tenant holds simply does not exist in the caller's tenant and **both cases answer `200`**. The oracle stops existing; it is *not* added to `security-guide §2.2`, which **stays at exactly TWO documented exceptions**. Do not "helpfully" add a third — §2.2's own intro now records this case as the precedent for removing rather than documenting.

This also corrects what 141a first wrote here, which was wrong: that the difference is "inherent to create-by-caller-supplied-id" and removable only by a lying `200` or server-generated ids. Tenant-scoping was a third option the analysis missed — a confident sentence that survived two review rounds because it read as reasoning rather than as a claim to check (CLAUDE.md §2.11).

### Why the ruling went this way — the numbers, not the shape

**Do NOT pre-justify anything with "the same entropy argument as the push token".** That argument does not exist any more: §2.2's exception 2 was re-based on the 30/day probe budget because Expo publishes no entropy for its token and the "~88 bits" in D22 §2 traced to a *test fixture* (`apps/server/test/helpers/push.ts`), not to Expo. The evidence that decided D23 §2:

- **Key width — traceable here, unlike the token's.** A media id is a UUIDv7, so 128 − 48 (timestamp) − 4 (version) − 2 (variant) = **74 random bits**, from a spec this repo controls (10-db §2). That figure is sound; it is what a citable number looks like.
- **Probe budget — the load-bearing evidence.** `POST /v1/media/:id/init` sits behind the per-device media limiter at **120/min/device** (`routeLimit` on `/:id/init`, `apps/server/src/routes/media.ts:130-183`, fed by `perRoutePerMinute: 120` at `apps/server/src/deps.ts:71`) ≈ **172,800 probes/day** — three orders of magnitude looser than push registration's 30/day, and a *rate* rather than a daily cap. Since exception 2's entropy leg was withdrawn, the budget is the **only** leg it has, and that leg does not reach here. Documenting a third exception was available and cheap; it was ruled out because its justification could not be borrowed.
- Media ids also reach a client only inside ops it was authorized to pull, so the legitimate case never needs the distinction.

### Handover

The fix is its own task (referenced by slug — **the media-id tenant-scoping task** — rather than by number, because ids in this range are being allocated concurrently today). **It carries a DB migration, and migrations serialize globally (CLAUDE.md §4), so it cannot run beside another migration task.**

Until it lands the difference stays pinned in the harness as `KNOWN_EXISTENCE_CONTROL_DIFFERENCES` — the exact violation text, so a *second* endpoint joining fails the sweep, this one leaving fails it, and this one changing character fails it. **That last property means the fix itself will turn the pin red: that red is the success signal, and the correct response is to DELETE the entry, never to widen the assertion.** The pin's header comment says so at the site.

**Also unfixed (out of 141a's scope — no route change was authorized):** the cross-device `403` at `push.ts:37-39` still returns *before* the 30/day `enforce(...)` at `:43-50`, so denied cross-device attempts consume no budget. The cross-**tenant** collision `403` is raised at `:100`, i.e. **after** the limiter, so the documented §2.2 exception's probe rate *is* capped — the entropy rationale in §2.2 says only that, and it was verified against the code, not assumed.
