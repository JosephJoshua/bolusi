# TASK 118 — `POST /v1/push/tokens` 500s when a client-supplied Expo push token already belongs to another device/tenant, instead of applying api/04-push §2's "last registrant wins"

**Status:** todo
**Priority:** MEDIUM — a 500 on a global-UNIQUE collision (same 23505-escape MECHANISM as task 114), but a DIFFERENT class: the colliding value is a secret FCM/Expo token, not an enumerable id, so it is not a practical cross-tenant existence oracle. Still a real defect — a spec'd path returns INTERNAL, and token ownership isn't reconciled.
**Depends on:** 21 (push registration), 114 (the shared `isUniqueViolation` helper it reuses)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the orchestrator, 2026-07-21, from task 114's class-sweep (114 flagged this as a separate defect and correctly did NOT patch it there).

## The finding (task 114, reproduced on real PG16)

`POST /v1/push/tokens` returns **500 INTERNAL** when the client-supplied `expo_push_token` (a GLOBAL `UNIQUE` column) already belongs to another device/tenant — the insert trips the unique index, `23505` escapes uncaught (owner `l3lane-98863-…`, body `{"error":{"code":"INTERNAL",…}}`). It shares task 114's mechanism (`23505` escaping as 500) but is its own class: the collision is on a secret token value, not an id, so it is not an existence oracle — but the endpoint still 500s instead of doing the right thing.

## The decision is already in the spec — apply it, don't re-decide

`api/04-push §2` states **"last registrant wins"** for token registration. So the correct behaviour on a collision is **ownership transfer**: the token moves to the newest registering device (upsert / re-point), NOT a 500 and NOT a hard reject. Read `api/04-push §2` and confirm the exact rule before coding; if it is genuinely ambiguous (it should not be), STOP and report rather than guessing. Do NOT weaken any tenant-scoping — a token transfer must still respect the registrant's tenant/device auth.

## Deliverable
- Fix `apps/server/src/routes/push.ts` so a colliding `expo_push_token` applies §2's "last registrant wins" (upsert/transfer to the new device), reusing `apps/server/src/db-errors.ts`'s `isUniqueViolation` (task 114) — do NOT add a fourth 23505 detector (§2.8). Fail closed on anything that is not a clean transfer; never 500 on the collision.
- Keep the response consistent with §2 (a successful registration response, not an error, when the transfer succeeds).

## FALSIFY (§2.11 — REPORT it, real PG16, attributed T-14d)
- Reproduce first: register token T on device A (tenant 1), then register T on device B → BEFORE the fix, 500 INTERNAL. Lead with that.
- After the fix: the second registration succeeds and T now points at B (last registrant wins) — assert the ownership moved, and A no longer owns T. Positive control: a fresh unique token registers normally.
- Break the fix (remove the collision handling) → the reproduction 500s again → RED. Restore → green. Report verbatim with DB attribution.

## Constraints / coexistence
Contended: none new. You touch `apps/server/src/routes/push.ts` + its tests (+ read `db-errors.ts`, don't change it). Do NOT touch `.github/workflows/ci.yml`, the harness security tests, or other routes. If you find yet another 23505-escape site, file it — don't fold it in.

## Verify (read OUTPUT not exit codes — §2.1; server resolves to dist — `npx tsc -b` before test:server)
- `npx tsc -b` EXIT 0; `pnpm typecheck` EXIT 0; `pnpm lint` EXIT 0.
- `npx tsc -b && pnpm test:server` (real PG16, attributed) — green, incl. the new collision test.

## Commit + status
Atomic subject-only Conventional Commit (e.g. `fix(server): push-token collision applies last-registrant-wins, not 500`). No body/attributions. Hooks mandatory. Do NOT flip Status; do NOT merge.

## Note
The last of task 114's class sweep. 114 closed the three id-oracle sites (media/enroll/op-log) and left this one because its fix is a product rule (transfer vs reject), not a mechanical 404-map — but the rule already exists in api/04-push §2, so this is applying the spec, not deciding it.
