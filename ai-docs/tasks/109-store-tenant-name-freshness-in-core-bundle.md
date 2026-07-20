# TASK 109 — store/tenant NAME freshness: move the name persistence into core's bundle-apply so a rename refreshes it (task 94's mobile workaround goes stale)

**Status:** in-progress
**Priority:** **LOW-MEDIUM** — no live incident: task 94 correctly persists `deviceName`/`storeName`/`tenantName` and Settings renders them. The gap is FRESHNESS — task 94 could only persist them **mobile-side from the transient enroll response** (`@bolusi/core` was off-limits for that task), so a tenant/store **rename without re-enrollment** leaves those two NAMES stale on the device. The stable identifiers (`deviceId` — the revocation key — and `deviceName`) never drift; only the display names of store/tenant can.
**Depends on:** 94
**Blocks:** —
**SEC ids owned by THIS task:** none

## The finding (task 94, producer-traced)

`store.name` / `tenant.name` are NOT in any queryable table — the directory mirrors carry user/role names only; the store/tenant display names arrive **solely in the transient enroll response** (and in `bundle.store.name` / `bundle.tenant.name` on every pull bundle). Task 94 persisted them mobile-side (`apps/mobile/src/bootstrap/{device-info,enrollment}.ts`) into `meta_kv` at enroll time — correct for the blank-Settings fix, but it only refreshes at enrollment. `@bolusi/core`'s `applyBundle`/`runEnrollment` already HOLD `bundle.store.name`/`tenant.name` on every sync bundle refresh, so persisting the names THERE keeps them current across renames.

## Acceptance

- Move (or mirror) the store/tenant name persistence into `@bolusi/core`'s bundle-apply path (`applyBundle` — it already receives `bundle.store.name`/`tenant.name` on every pull), writing them to `meta_kv` so a rename delivered on the next bundle refreshes the on-device names. Keep `deviceName` where task 94 has it (it's the owner-typed genesis value, doesn't come on the bundle) OR consolidate — your call, but ONE source.
- Task 94's mobile `persistEnrolledNames` at enroll time can stay as the initial write, or be subsumed if bundle-apply covers the first bundle — avoid two writers of the same key that can disagree (§2.8); if both remain, add a note on the ordering.
- **Falsify (§2.11):** a test that a tenant/store rename delivered via a pull bundle updates the on-device `storeName`/`tenantName` (was stale before). Break the bundle-apply write → the name stays stale → RED → restore → green. (Client-side; use the real `applyBundle`.)
- `pnpm typecheck`/`pnpm lint`/`pnpm test` green — read the output (§2.1).

## Note
Filed from task 94. Task 94 was scoped out of `@bolusi/core`, so it did the honest mobile-side fix + flagged this as the proper home. The rename-staleness is bounded (display names only; the revocation-critical `deviceId` is always correct) — hence LOW-MEDIUM, not a v0 blocker. Related: D19 (`ai-docs/decisions/2026-07-20-appversion-source.md`) — the `appVersion: ''` source — is an OWNER decision (pin `expo-constants` vs ratify `''`), filed by task 94, **still Proposed / needs a ruling**.
