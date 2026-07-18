# TASK 97 — `CLIENT_MODULES` (apps/mobile) still omits `authModule`, so `auth.*` ops fold as `unregistered` ON DEVICE

**Status:** done
**Priority:** **MEDIUM** — the mirror of task 43's server fix, one layer over. Task 43 registered `authModule` in `SERVER_MODULES` so the server folds `auth.*`; the **device** side (`apps/mobile/src/bootstrap/modules.ts` `CLIENT_MODULES`) still = `[platformModule]`, so on-device the same ops fold via the projection engine's `unregistered` no-op — `auth_sessions` / `pin_lockout_events` / `auth_permission_denials` stay empty on the client. The on-device denial audit / session projection is write-only until this lands. Its own comment already names task 43 as the owner of this line.
**Depends on:** 43
**Blocks:** —
**SEC ids owned by THIS task:** none (same FR-1045 audit-trail surface as task 43, client side)

## The finding (task 43, out-of-scope by constraint)

impl-43 fixed the **server** half (`SERVER_MODULES += authModule`) but was constrained not to touch `apps/mobile` (another agent — impl-92 — was live there). It verified and reported: `apps/mobile/src/bootstrap/modules.ts` `CLIENT_MODULES` is still `[platformModule]`, and its own comment says task 43 must append `authModule` there too. So the device folds `auth.*` as `unregistered`.

The `authModule` is now built and platform-free (`packages/core/src/auth/module.ts`, shipped by task 43) — this is genuinely a one-line registration plus its falsification, not new module work.

## Acceptance

- Append `authModule` to `CLIENT_MODULES` in `apps/mobile/src/bootstrap/modules.ts`; remove/refresh the stale comment that points at task 43.
- **Falsify the registration (§2.11, the handoff-ring lesson task 49/43 carry):** push/apply a real `auth.*` op through the **device** apply path (the client runtime's projection apply — `applyBundle` / the op-store apply seam task 92 wired, NOT a hand-seeded row) and assert the client projection row appears (e.g. a `permission_denied` becomes readable via the client `listPermissionDenials`, or a `user_switched` folds into `auth_sessions`); then remove `authModule` from `CLIENT_MODULES` and watch it go RED (folds nothing). Report "removed line → saw X empty → restored → green".
- Confirm the client module set and server module set now fold the SAME `auth.*` types (no client/server divergence — the two registries must name the same module set, per task 49's `registerModules` invariant applied on both sides).
- `pnpm typecheck`, `pnpm lint`, `pnpm --filter @bolusi/mobile test` green — read the output (§2.1).

## Note
Filed from task 43's report (finding f-1). The server/client split is the same shape as every handoff ring on this project: one half ships and looks done, the other half folds nothing silently. Task 43 closed the server half honestly and flagged this rather than reaching into a contended app — the right call (§4).
