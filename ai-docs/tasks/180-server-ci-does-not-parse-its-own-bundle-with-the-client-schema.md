# TASK 180 — the server never parses the bundle it emits with the client's `DeviceBundleSchema`, so a client-incompatible bundle passes server CI and breaks enrollment silently

**Priority:** LOW — latent today (the divergence is not reachable with current data), but it is a cross-boundary CI blind spot on the server→client trust boundary, and the fix is one assertion.
**Depends on:** 161 (which added `DeviceBundleSchema` and the client-side parse)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-161 reviewer, 2026-07-25 (non-blocking observations 1 + 2).

## The finding
Task 161 made the CLIENT parse the bundle at `applyBundle` with `DeviceBundleSchema` (fail-closed). But **nothing on the SERVER asserts the bundle it produces satisfies that same schema.** The gate runs client-side only, so a bundle the server considers valid but the client schema rejects would pass every server test and only fail at a real device's enrollment — with no CI signal.

Two concrete divergences the 161 reviewer identified:

1. **`zPermissionId` caps permission-id length at 64; the server registry has NO length cap.** `PERMISSION_ID_PATTERN` (`packages/core/src/authz/registry.ts:25`) enforces the `<module>.<action>` shape but not a length. So a future permission id > 64 chars would pass `assemblePermissionRegistry` (and server CI) yet be REJECTED by the client schema → enrollment breaks for any tenant whose role holds that id. Latent now (longest shipped id is 29), but it lands silently the day a long id is added.

2. **Client is stricter than the server on names.** DB name columns are `text NOT NULL` (no length, empty allowed; `0002…`/`0004…` migrations). The client schema adds `min(1).max(200)` (display) / `min(1).max(64)` (user, spec §5.4). The only realistically-reachable divergence is `provision-tenant --store-name ""` → `store.name: ''`, which `min(1)` rejects — but that is invalid provisioning data with no rename API to reach it later, so it fails closed and is not a legitimate-traffic reject. Note-only; item 1 is the real gap.

## Deliverable
Add a server-side assertion that the produced bundle round-trips through the CLIENT schema, so the server CI catches a client-incompatible bundle at the point the incompatibility is introduced (a new long permission id, a new bundle field, a tightened client bound):

- In `apps/server/test/identity/bundle.test.ts` (or wherever `buildBundle`/the bundle assembler is tested), add `DeviceBundleSchema.safeParse(builtBundle).success === true` over a bundle that carries a `main_owner`-style role holding EVERY permission id (the maximal case the reviewer used). This makes a >64-char id — or any future client/server drift — a RED in server CI instead of a silent enrollment break.
- Decide the right long-term reconciliation for item 1: either give `PERMISSION_ID_PATTERN` a matching length cap (so the two agree by construction at the registry), or raise/remove the client cap — whichever the spec supports. Do NOT just widen the client to "accept anything"; the point is the two boundaries agree.

## FALSIFY (§2.11)
- Add a deliberately-too-long permission id (or a name over the cap) to the assembled registry fixture → the new server-side assertion must RED naming it → remove. That proves the server CI now catches what only the client caught before.
- Positive control: the real assembled registry (19 ids, max length 29) still passes — do not make the assertion so tight it rejects real traffic (the 161 reviewer confirmed the real bundle passes; keep it passing).

## Note
This does not change client behaviour (161 already fails closed correctly); it moves the DETECTION of a client/server bundle divergence from "a device fails to enroll in the field" to "server CI goes red." §2.8-adjacent: the two ends of one wire contract should be checked against one schema.
