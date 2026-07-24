# TASK 170 — tenant-scope the media id so `POST /v1/media/:id/init` stops being a cross-tenant existence oracle

**Status:** todo
**Priority:** **HIGH security** — a live cross-tenant existence oracle, ruled for a real fix rather than a documented exception (D23 §2). It is the third such oracle found in this surface and the only one that is being removed instead of justified.
**Depends on:** 141a (its SEC-TENANT-04 walk is what detects this, and its pin must be deleted by this task)
**Blocks:** —
**SEC ids owned by THIS task:** none new — this task DISCHARGES an existing finding under SEC-TENANT-04.
**Filed by:** orchestrator, 2026-07-23, on owner ruling **D23 §2**.

## The finding
`POST /v1/media/:id/init` answers `404 MEDIA_NOT_FOUND` for a media id **another tenant holds**, and
`200 {"chunkSize":262144,…,"status":"receiving"}` for a globally-free one. Held-vs-free is therefore
distinguishable across a tenant boundary — an existence oracle over ids the caller was never shown,
which security-guide §2.2's table forbids.

Reproduced twice independently: by task 141a's implementer, and by its reviewer via the SEC-TENANT-04
control walk. It is currently pinned in `KNOWN_EXISTENCE_CONTROL_DIFFERENCES` pending this fix.

## Why it is NOT being documented as a §2.2 exception (the ruling)
The obvious cheap path was to add it as "documented exception 3" alongside media-download and
push-token registration. **It cannot borrow exception 2's justification.** Task 141a traced this
route's budget to `routeLimit` → `perRoutePerMinute: 120` (`apps/server/src/deps.ts:71`) —
**120/min, not 30/day**. That is ~172,800 probes/day against UUIDv7's 74 random bits: three orders of
magnitude looser than the push-token budget, and a *rate* rather than a daily cap. Since exception 2's
entropy leg was withdrawn (D22 §2 addendum — the "~88 bits" traced to a test fixture), the budget is
the only leg that exception has, and that leg does not reach this route.

So the owner ruled: **remove the oracle, don't justify it.**

## Deliverable
Make media id uniqueness **`(tenant_id, id)`** rather than global, so an id another tenant holds
simply does not exist in your tenant and both cases answer `200`.

- DDL + migration in `ai-docs/10-db-schema.md`'s terms; update the primary key / unique index and every
  lookup that assumes a global id.
- **DB migrations serialize globally (CLAUDE.md §4)** — do not run this concurrently with another
  migration task. Check the board before starting.
- Audit every read path that resolves a media id: any query that finds a row by `id` alone is now a
  cross-tenant read and must carry the tenant predicate. RLS is tenant-scoped (`secureTenantTable`),
  so most are already covered — **verify rather than assume**, and say which you checked.
- Confirm the client side does not depend on global uniqueness anywhere (`media_items.local_path`
  resolution, the upload queue, `MediaRef` in `note_created` v3 payloads).

## DELETE THE PIN — this is part of the deliverable, not a follow-up
`KNOWN_EXISTENCE_CONTROL_DIFFERENCES` in task 141a's SEC-TENANT-04 suite pins
`POST /v1/media/:id/init` as a known difference. That pin is **bidirectional** — its reviewer verified
it fails on join, on empty, AND on stale — so **it will go red the moment this fix lands**.

**That red is the signal to delete the entry, not to widen the assertion.** A future engineer seeing
it red has every incentive to relax it; the pin carries a comment saying so, and this task is the
event that comment anticipates.

## FALSIFY (§2.11 — REPORT it)
1. **Reproduce the oracle first**, before the fix: init with a media id another tenant holds → `404`;
   init with a free id → `200`. Paste both actual responses. If it does not reproduce, STOP — the
   premise would be wrong (T-11), and two tasks this project has already been filed on dead premises.
2. After the fix: the same two requests must be **indistinguishable**. Assert on status, code, AND
   body — a difference that moves from the status line into the body is not a fix (a review this week
   caught exactly that shape: an endpoint set stayed identical while the 404 body began leaking the
   foreign tenant's id).
3. **Positive control:** a legitimate double-init of the caller's OWN in-flight id must still behave
   as api/03-media specifies. Do not close the oracle by making the endpoint useless.
4. **Cross-tenant collision:** two tenants holding the same media id must both work independently —
   that is the whole point of the scoping. Prove it with a real pair of rows, not a unit test on the
   index definition.
5. Then delete the pin and watch SEC-TENANT-04 go **green with one fewer documented difference**, and
   confirm §2.2 still parses to exactly **two** exceptions (task 141a asserts that count).

## Note
security-guide §2.2 stays at exactly two documented exceptions. Do NOT add a third while doing this
work — the whole point of the ruling is that this one does not become one.

## PROGRESS + A BLOCKER FOUND (2026-07-24, orchestrator, main loop)

WIP is in worktree `.claude/worktrees/task-170` (branch `task/170-tenant-scope-media-id`), **uncommitted but complete for the DB/handler layer and proven on real PG16**:

**DONE and falsified (§2.11 green→red→green on PostgreSQL 16.14, own container stamp):**
- Migration `0011_media_id_tenant_scoped.ts`: `media` PK `(id)` → `(tenant_id, id)`; `media_chunks` PK `(media_id, chunk_index)` → `(tenant_id, media_id, chunk_index)` (else two tenants sharing an id collide on chunk 0 — caught while tracing); `media_chunks` FK rewritten to the composite `(tenant_id, media_id) → media(tenant_id, id)`.
- `apps/server/src/routes/media.ts`: both `onConflict` targets made composite; the false "global unique index" comment rewritten.
- `ai-docs/10-db-schema.md` §8 media + media_chunks DDL updated to match.
- `apps/server/test/integration/media/tenant-scoped-id.test.ts` (the prior agent's adversarial test): **4/4 pass** — indistinguishability on status+code+body, two-rows-one-id, and the cross-tenant collision end-to-end (each tenant downloads ITS OWN bytes). Reverting the fix reds it exactly on the oracle (`expected 404 to be 200`); restoring greens it.

**THE BLOCKER (this is why the task is bigger than "delete the pin"):**
Tenant-scoping the id **invalidates the SEC-TENANT-04 media cross-tenant probe model across all five media endpoints**, not just init. The walk (`packages/harness/src/security/probe-registry.ts` `mediaProbes`, asserted in `sec-tenant-04.test.ts`) probes media by targeting `ctx.tenantBMediaId` and expects a uniform `404` (SEC-MEDIA-03 / §2.2 exception 1: "every out-of-scope media id is one indistinguishable 404"). **That premise is now false: a bare media id is no longer a cross-tenant reference** — `tenantBMediaId` is simply a free id in tenant A's namespace. Observed on real PG:
- `POST /:id/init` cross-tenant → **200** (correctly creates a row in tenant A; the walk misreads it as "LEAK: 200 on out-of-scope access").
- That init **side-effect row** then contaminates the shared-id legs: `GET /status` → 200, `PUT /chunks/0` → CHUNK_SIZE_INVALID, `POST /complete` → CHUNKS_MISSING — none is the expected 404.

So SEC-TENANT-04 REDS after the fix, and **emptying `KNOWN_EXISTENCE_CONTROL_DIFFERENCES` is not sufficient** — the pin covered the specific "404 vs 200" strings, but the actual behavior is now different strings, and four other legs moved too.

**Remaining work (a security-walk redesign — §2.5 care, NOT a rush):**
1. Split `init` out of the shared-404 `mediaProbes` model. Its correct security property is **held == free**: init at `tenantBMediaId` and init at a never-used id must both return the SAME response (200 for enrolled metadata), revealing nothing about tenant B. Assert that equality, not a 404.
2. The read/mutate legs (`chunks`/`status`/`complete`/`download`) must probe an id tenant A genuinely never created (and that init did not side-effect into existence) so they still return a uniform 404 — OR the probe must target tenant B's ACTUAL uploaded media through a mechanism that survives tenant-scoping (the real cross-tenant question is now "can tenant A read tenant B's blob," which the collision test already answers: no, blobs are tenant-prefixed).
3. THEN empty the pin and confirm SEC-TENANT-04 green.
4. `db:codegen:check` failed on a db:up infra contention (a container was already up), NOT on real drift — re-run uncontended; a composite-PK change does not alter kysely-codegen column output, so expect no `db.ts` diff, but verify.

This is a §6-adjacent security-surface change with a wider blast radius than the ruling's "tenant-scope the id" implied. It is preserved, proven at the DB layer, and precisely characterized — resume from the worktree; do the walk redesign carefully with the held==free adversarial assertion before review (§2.5), and get a separate reviewer (§2.9).
