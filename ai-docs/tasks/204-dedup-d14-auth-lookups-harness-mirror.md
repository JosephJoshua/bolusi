# TASK 204 — collapse the verbatim D14 auth-lookup copy: `@bolusi/harness` `createPgliteAuthDirectory` mirrors `@bolusi/db-server` `auth-entry.ts` line-for-line, sole delta the driver handle

**Depends on:** 201 (it landed `packages/harness/src/production-auth.ts`, the second copy)
**Blocks:** — (maintainability / drift-prevention; no behavior change)
**SEC ids owned by THIS task:** none — but see **the security-design fork** below: the obvious DRY fix widens a deliberately-closed encapsulation, so this task must NOT be executed as a reflexive extraction.
**Priority:** MEDIUM — no current failing input, but the two copies are a **security-boundary** read path (D14, the only cross-tenant SELECT in the system), and the copy is the "faithful oracle" the emulator lane leans on; silent drift here degrades an auth fidelity guarantee, not just a test helper.
**Filed by:** review-wave of task 201 (2026-09-08). Duplication lens found it; adversarial verify **confirmed it factually real** (byte-diff below) and refuted it only as a *task-201 merge blocker* (no concrete failing input today — both copies are correct as written, and the harness copy's return types are pinned to the imported records, so *some* drift is a compile error). Per the review-wave skill a confirmed duplication becomes an extraction task naming every copy by path; per CLAUDE.md §2.8 there is one implementation, not per-package copies. Sibling of how review-wave-198→200 and review-wave-200→202 were filed.

## The finding (one copy-set, already at the rule-of-three trigger's spirit — two copies of a security path)

The three D14 SECURITY DEFINER lookups (`auth_find_device_by_token_hash`, `auth_find_control_session_by_token_hash`, `auth_find_login_credential`) are hand-written **twice**, the SQL byte-identical:

- **Canonical / oracle** — `packages/db-server/src/auth-entry.ts`
  - `findDeviceByTokenHash` → `auth-entry.ts:49` (`.execute(getDb())`)
  - `findControlSessionByTokenHash` → `auth-entry.ts:65` (`.execute(getDb())`)
  - `findLoginCredential` → `auth-entry.ts:91` (`.execute(getDb())`)
- **Copy** — `packages/harness/src/production-auth.ts` (`createPgliteAuthDirectory(db)`)
  - `findDeviceByTokenHash` → `production-auth.ts:55` (`.execute(db)`)
  - `findControlSessionByTokenHash` → `production-auth.ts:68` (`.execute(db)`)
  - `findLoginCredential` → `production-auth.ts:91` (`.execute(db)`)

~50 lines of SQL bodies duplicated: identical SELECT column lists, identical explicit quoted aliases, identical inline `sql<{…}>` row generics, identical `Number()` int8 coercion on the control-session `expiresAt`/`revokedAt`, identical fail-closed `if (row === undefined) return undefined` / `return rows[0]`. **Sole delta: the driver — `.execute(getDb())` → `.execute(db)`.**

This is a **self-admitting** copy. `production-auth.ts:16-20` states it outright: "The three bodies are `packages/db-server/src/auth-entry.ts` VERBATIM — identical SQL, identical explicit column aliases, identical `Number()` coercion … with the single, sole delta being the driver." Per the review-wave skill's duplication lens, an aware copy that cites its twin is a **finding, not an excuse** — the 2026-07-26 audit found the citing comment is exactly how copies drift (`severity()` diverged between two Verdict enums that linked to each other).

### Why the existing compile-time coupling is only a PARTIAL guard (do not close this as "already caught")

`production-auth.ts` imports the record types (`DeviceAuthRecord`, `ControlSessionAuthRecord`, `LoginCredentialRecord`) from `@bolusi/db-server` and returns them, so a **field add** to a record type is a compile error in the harness copy. That is real, but it does not catch the drift that matters here:
- the SQL **column list / alias** is a string literal in each copy — rename a definer column + its alias in the oracle and the harness copy silently selects the old name (or `undefined`), no compile error;
- the `Number()` int8 coercion is **duplicated logic**, not a shared function — drop or change it on one side only and nothing reds until a token actually expires on the lane.

So the copies can diverge in a way that makes the emulator lane's "production-auth" path stop faithfully mirroring the real server — defeating the emulator-lane-hops discipline ("verify each new hop against a faithful oracle") the mirror was built to satisfy.

## The security-design fork (why this is NOT a reflexive extract-and-go)

The naive DRY fix — hoist the three bodies into functions parameterized over a `Kysely<DB>` handle and have both callers pass their driver (`getDb()` internally, the PGlite `db` in the harness) — **widens `@bolusi/db-server`'s exported surface to accept an arbitrary Kysely handle**. That is the precise thing the module's encapsulation was built to forbid: `auth-entry.ts:11-13` and the header note that `getDb` is *deliberately unexported* so "an arbitrary cross-tenant query still fails closed … there is no way through it to run an arbitrary cross-tenant query." `production-auth.ts:8-14` exists *because* of that closure — it could not reuse the real path, so it mirrored the SQL over a driver the harness already holds.

Therefore the resolution is an owner-facing design choice, not a mechanical extraction. Candidate approaches, to be decided in this task (spike + short decision note if the chosen one touches the db-server export surface, §4 / §6):
1. **Shared SQL fragments, not shared execution.** Extract only the three SQL query *builders* (the `sql\`…\`` template + row generic + the `Number()` post-map) into a shared, driver-agnostic module both files import and each `.execute()`s with its own handle — no raw handle is exported, the definer-gating stays where it is, and the coercion lives once. This is the strongest candidate: it removes the literal drift surface without exporting `getDb` or accepting an outside handle into db-server's authz path.
2. **Keep two copies, add a drift GUARD instead of extracting** — a test that asserts the harness copy's emitted SQL string is byte-identical to the oracle's (the copies opt into being policed, like task 188's rejected dual-store-plus-gate shape). Weaker: two sources of truth remain; only file if (1) is judged to breach the boundary.
3. **Owner re-scopes** the harness to not need a production-auth mirror at all (unlikely given 201-B shipped it, but record if raised).

Pick with the owner before writing code; do not export `getDb` or thread an external Kysely into `auth-entry.ts`'s authz functions without a decision file — that would be a §6 security-control change.

## FALSIFY (§2.11) — before collapsing, prove they are safe to collapse

- **Byte-identity of the SQL first.** Confirm the three `production-auth.ts` bodies still match `auth-entry.ts` verbatim modulo the driver (they do as of this filing — `origin/main` HEAD carrying 201). If either side has drifted by the time this is picked up, that drift **is** a finding: reconcile it deliberately (which is correct?), don't collapse by fiat to whichever copy you started from.
- **Duplication actually gone (load-bearing):** after extraction (approach 1), `grep -rn 'auth_find_device_by_token_hash' packages --include=*.ts | grep -v node_modules | grep -v /dist/` shows the SQL literal **once** (the shared builder) + two `.execute()` call sites — not two literals. Same for the other two functions and for the `Number(row.expiresAt)` coercion. Falsify by re-inlining one copy and confirming a lint/knip/dup guard (or the byte-identity test from approach 2) reds, then revert.
- **Boundary preserved (the security check):** after the change, prove `@bolusi/db-server` still exports NO raw Kysely/`getDb` handle and no way to run an arbitrary cross-tenant SELECT — `auth-entry.test.ts`'s existing fail-closed proof must stay green, and there must be no new export through which an unscoped query is expressible. Break it (temporarily export `getDb`) and confirm a boundary/knip guard reds if one exists; if none does, that absence is itself worth a note.

## Acceptance

- The three D14 SQL bodies (SELECT + aliases + row generic + `Number()` coercion + fail-closed handling) exist in **one** source; `auth-entry.ts` and `production-auth.ts` each only bind a driver to it.
- `@bolusi/db-server`'s cross-tenant closure is intact: no exported raw handle, `auth-entry.test.ts` fail-closed test green, no arbitrary-cross-tenant-query path added.
- Behaviour-preserving: `@bolusi/db-server` + `@bolusi/harness` suites green before and after; the emulator-lane production-auth path is unchanged.
- No new coupling into production surfaces beyond the shared SQL module; `apps/mobile` gains no `@bolusi/harness` / `@bolusi/server` dependency (standing constraint); `@bolusi/harness` stays `"private": true` and does not become an `apps/mobile` dependency.
- `pnpm typecheck` / `lint` / `knip` (+0 new) green.

## Note

Contended: touches `@bolusi/db-server`'s auth surface. Do NOT fold into 201 (out of its enrollment-seam scope, and the design fork above needs its own review). Extract on its own branch off `origin/main` after 201 merges; if the chosen approach touches the db-server export surface, write the decision note first (§4/§6), then `review-wave`.
