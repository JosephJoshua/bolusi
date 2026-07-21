# TASK 114 — `POST /v1/media/:id/init` answers **500** for a cross-tenant media id and **404** for a same-tenant one: a cross-tenant existence oracle

**Status:** in-progress
**Priority:** **HIGH — live security defect on a shipped endpoint.** It is the exact property `security-guide §2.2`'s media exception exists to remove, and it is reachable by any enrolled device with a guessable UUIDv7.
**Depends on:** 19 (media-server, done)
**Blocks:** 28 (security-sweep — SEC-TENANT-04's cross-tenant leg is RED on this row and stays red until this lands)
**SEC ids owned by THIS task:** none.
**Invariants owned by THIS task:** none.
**Filed by:** task 28's SEC-TENANT-04 route walker, 2026-07-21 — found by the probe, reported not patched (CLAUDE.md §2.6/§2.7).

## The finding (measured, not reasoned)

`packages/harness/test/security/sec-tenant-04.test.ts`, cross-tenant leg, against the real composed `@bolusi/server` on PGlite with two seeded tenants:

```
POST /v1/media/<tenant-B media id>/init      → 500 {"error":{"code":"INTERNAL", ...}}
POST /v1/media/<tenant-A store-2 media id>/init → 404 {"error":{"code":"MEDIA_NOT_FOUND", ...}}
POST /v1/media/<never-existed id>/init          → 404 {"error":{"code":"MEDIA_NOT_FOUND", ...}}
```

So the **status code distinguishes "this media id exists in another tenant" from "this media id does not exist"**. That is an existence oracle across the tenant boundary — precisely what `security-guide §2.2`'s documented media exception is written to deny ("cross-tenant, same-tenant unassigned store, another device's in-flight upload, and nonexistent are indistinguishable"), and what SEC-MEDIA-03 asserts for the *download* route. The upload-init route was never probed for it.

## Root cause

`media.id` is a **global `uuid PRIMARY KEY`** (`packages/db-server/migrations/0005_media_push_projections.ts`), not `(tenant_id, id)`. Inside tenant A's `forTenant` transaction, RLS hides tenant B's row from the handler's `SELECT ... WHERE id = :id`, so `existing === undefined` and the handler proceeds to `INSERT` a new row with the client-supplied id. The insert then trips the **global** unique index — a `23505` no handler catches — and `app.onError` maps the unknown error to `500 INTERNAL`.

This is the well-known Postgres RLS covert channel: **RLS filters `SELECT`s, it does not hide unique-index conflicts.** Every id-keyed create/upsert whose primary key is not tenant-scoped has the same shape, so the fix must be checked against them, not just this one route.

## Docs to read

- `security-guide.md` §2.2 (the rule table + the media exception — the oracle) and §7 (media surface checklist, SEC-MEDIA-03).
- `api/03-media.md` §2 (upload binding / 404 semantics) and §3.1 (`init`, `INIT_MISMATCH`, `MEDIA_IMMUTABLE`).
- `10-db-schema.md` §6 (RLS) and the media DDL; `api/00-conventions.md` §7 (status/code registry).

## Acceptance

- A cross-tenant `POST /v1/media/:id/init` returns **`404 MEDIA_NOT_FOUND`**, byte-identical (beyond `requestId`) to the same-tenant-unassigned-store, other-device-in-flight, and nonexistent legs.
- The fix is at the **class**, not the instance (testing-guide T-13): audit every id-keyed insert whose primary key is not tenant-scoped for the same unique-violation-through-RLS leak, and state in the task report which ones were checked and what each does.
- **Falsify it:** revert the fix, watch SEC-TENANT-04's cross-tenant leg name this endpoint again, restore, watch it go green. Report the verbatim red.
- `pnpm test:security` (`packages/harness/vitest.security.config.ts`) green on the cross-tenant leg; `pnpm test:server` green; `pnpm lint` / `pnpm typecheck` green.

## Note

Whether the correct fix is a tenant-scoped primary key, a caught-and-mapped `23505`, or a definer-function existence check is a design call for the implementer — but a caught `23505` mapped to `404` must not become a general "swallow unique violations" habit: `INIT_MISMATCH` and `MEDIA_IMMUTABLE` (api/03-media §3.1) are *legitimate* conflict answers on this same route and must keep their codes.
