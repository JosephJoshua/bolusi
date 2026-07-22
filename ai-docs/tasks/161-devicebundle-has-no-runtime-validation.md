# TASK 161 — `DeviceBundle` is a plain TypeScript interface with NO zod: every field the server sends is unvalidated at runtime before it reaches the client DB

**Status:** todo
**Priority:** MEDIUM — the immediate DoS instance is closed by task 148's keyed marker, but the underlying gap (server text entering the client with zero runtime validation) is broader than that one symptom and outlives it.
**Depends on:** 148 (which surfaced it)
**Blocks:** —
**SEC ids owned by THIS task:** none currently — consider whether the bundle-apply path warrants one (it is the server→client trust boundary).
**Filed by:** the task-148 reviewer, 2026-07-22, while classifying plaintext-column reachability.

## The finding
`packages/schemas/src/auth.ts:130` — `DeviceBundle` is declared as a **plain TypeScript interface**. There is no zod schema, so **nothing validates it at runtime**. Every other wire type in `@bolusi/schemas` is a zod object parsed at the boundary; this one is types-only, which means the compiler is the only "check" and it evaporates at runtime.

Consequence: `bundle.store.name`, `bundle.tenant.name` and `rolesSnapshot[].name` are unvalidated server text that flows straight into the client DB (`meta_kv.value`, `roles_directory.name`). The 148 reviewer demonstrated one symptom — marker-shaped values in those fields threw on read:
```
[meta_kv.value] stored verbatim (plaintext by design)? true
[meta_kv READ via Kysely] THREW: Unsupported state or unable to authenticate data
[roles_directory.name] stored verbatim? true
[roles SELECT * via Kysely] THREW: Unsupported state or unable to authenticate data
```
That specific symptom is closed by 148's keyed marker. **The gap is not.**

## Why it still matters after 148
- `security-guide §1` lists "compromised server injecting history" as **in scope**. The bundle is precisely a server→client injection surface, and it is the one wire type with no runtime gate.
- Absence of validation means absence of *any* invariant: no length bound, no charset rule, no shape check. A future consumer of a bundle field (a display surface, a projection, a query predicate) inherits whatever the server sent.
- No v0 API can currently set these (`apps/server/src/routes/tenant.ts` exposes only `PATCH /settings`; there is no store/tenant/role rename endpoint), so today it requires provisioning-level access — but that is a property of the *current route surface*, not of the client, and it changes the moment a rename endpoint lands.

## Deliverable
Give `DeviceBundle` a real zod schema and parse it at the boundary where it enters the client (bundle apply / enrollment), the same way every other wire type is handled. Derive the field constraints from the specs (`api/02-auth`, `02-permissions`) — sensible length bounds and, where the spec implies one, a charset/format rule. Do NOT invent constraints the spec does not state; if a field is genuinely free-form, bound its length and say so.

## FALSIFY (§2.11 — REPORT it)
- A bundle with a malformed/oversized field is **rejected at the boundary** with a clear error, not written to the DB. Break the parse → the malformed bundle lands again → red. Restore → green.
- **Positive control:** a legitimate bundle (the one enrollment actually produces) still applies cleanly and every field round-trips — the schema must not reject real traffic. Run the existing enrollment/bundle-apply suites as the control.
- Assert the parse runs on the REAL apply path, not just in a unit test of the schema (this repo's recurring failure is a validator that exists but nothing calls — trace to the producer).
