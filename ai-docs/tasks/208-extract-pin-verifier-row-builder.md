# TASK 208 — extract the `userPinVerifiers` row builder: `@bolusi/harness` `seedOwnerPin` hand-rolls the exact insert-row `apps/server` `writeVerifier` owns, a second un-filed copy of a PIN-auth-boundary write path

**Depends on:** 201 (it landed `packages/harness/src/harness-provision.ts`, the second copy)
**Blocks:** — (maintainability / drift-prevention; no behavior change)
**SEC ids owned by THIS task:** none — but this is a PIN-verifier (auth-credential) write path; the copy silently degrades the emulator lane's "faithful oracle" fidelity if the server row shape moves, so treat it as a security-adjacent extraction (falsify byte-identity before collapsing).
**Priority:** MEDIUM — no current failing input (both copies are correct today), but the row lives on the PIN-auth boundary and the harness copy is the seed the emulator lane's on-device unlock depends on; a server-side row-shape change would NOT compile-error the harness copy (it imports no shared row type — the row is an inline `{…} as never`), so the lane would seed a verifier that no longer matches production with nothing red.
**Filed by:** review-wave of task 201 (2026-09-08), duplication lens; adversarially **CONFIRMED real** (byte-diff below) and refuted only as a *task-201 merge blocker* (no concrete failing input today). Per the review-wave skill a confirmed duplication becomes an extraction task naming every copy by path; per CLAUDE.md §2.8 there is one implementation, not per-package copies. **Distinct from task 204** — 204 scopes ONLY the three D14 `createPgliteAuthDirectory` lookups; this `writeVerifier`/`seedOwnerPin` row is a separate, unrecorded duplicate.

## Docs to read

- `api/02-auth.md` (PIN verifier credential shape / §5 verifier POST)
- `10-db-schema.md` (`userPinVerifiers` DDL — the row's source of truth)
- CLAUDE.md §2.8 (one implementation), §4 (contended shared packages serialize)

## The finding (two copies of one row on the PIN-auth boundary)

The `userPinVerifiers` insert row is hand-built **twice**, field-for-field:

- **Canonical / oracle** — `apps/server/src/routes/users.ts` `writeVerifier`, the `const row = {…}` at **`users.ts:442-452`**:
  `{ userId, tenantId, algo: 'argon2id' as const, salt: verifier.saltB64, params: { m: verifier.mKiB, t: verifier.t, p: verifier.p } as never, hash: verifier.hashB64, asOfTimestamp: BigInt(verifier.asOf.timestamp), asOfDeviceId: verifier.asOf.deviceId, asOfSeq: BigInt(verifier.asOf.seq) }`
- **Copy** — `packages/harness/src/harness-provision.ts` `seedOwnerPin`, the `.values({…})` at **`harness-provision.ts:107-117`**: the same nine fields in the same order, `algo: 'argon2id'`, `params: {…} as never`, both `BigInt(…)` coercions, `userId` in shorthand.

This is a **self-admitting** copy. `harness-provision.ts:8-9` says it outright ("write a user's PIN verifier row with REAL argon2id … the exact `userPinVerifiers` shape `users.ts writeVerifier` writes"), and `harness-provision.ts:82-84` repeats it. Per the review-wave duplication lens an aware copy that cites its twin is a **finding, not an excuse** — the 2026-07-26 audit found the citing comment is exactly how copies drift.

### The one real delta — statement shape, not row shape (scope the extraction to the ROW)

The two call sites differ in the **statement**, not the row:
- `users.ts:453-464` **upserts** — `.insertInto('userPinVerifiers').values(row).onConflict((oc) => oc.column('userId').doUpdateSet({ salt, params, hash, asOfTimestamp, asOfDeviceId, asOfSeq }))`;
- `harness-provision.ts:104-118` does a **plain insert** — `.insertInto('userPinVerifiers').values({…}).execute()` (fresh lane owner, no conflict to resolve).

So the shared unit is the **row builder** (the nine-field object literal, incl. both `BigInt` coercions and the `params` jsonb map), NOT the full Kysely statement. The `onConflict` clause stays in `users.ts`; the harness keeps its plain `.insertInto(...).values(row).execute()`.

## The extraction

Extract one driver-agnostic pure builder — e.g. `buildPinVerifierRow(verifier, { userId, tenantId }): UserPinVerifierRow` — into a shared home both files import, so the row shape lives **once** and is a **typed** value (not an inline `{…} as never`), so a server-side row-shape change is a compile error in the harness too.

- Home candidates (pick per §4 — the more-owned side wins): the `PinVerifier`→row map is domain-shaped and both sides already import from `@bolusi/core` (`buildPinVerifier`) / `@bolusi/db-server` (the row type) — prefer a small builder in the package that already owns the `userPinVerifiers` row type over inventing a new one; do NOT create an `apps/mobile → @bolusi/harness` (or `@bolusi/server`) edge (standing constraint), and `@bolusi/harness` stays `"private": true`.
- Kill the `as never` on `params` at the same time — type the field to the actual jsonb shape so the cast is unnecessary. If the cast is load-bearing (Kysely's generated column type is opaque), keep it in the ONE builder, not two.

## FALSIFY (§2.11) — before collapsing, prove they are safe to collapse

- **Byte-identity of the row first.** Confirm `harness-provision.ts:107-117` still matches `users.ts:442-452` field-for-field (they do as of this filing). If either has drifted by pickup, that drift **is** a finding — reconcile deliberately (which is correct?), don't collapse by fiat.
- **Duplication actually gone (load-bearing):** after extraction the nine-field literal appears **once** (the builder) + two call sites. Re-inline one copy and confirm a lint/knip/dup guard (or a builder-return-type mismatch) reds, then revert.
- **Behaviour preserved:** the `@bolusi/server` PIN-verifier route test AND the harness `pglite-production-auth.test.ts` (the §2.5 de-risk that exercises `seedOwnerPin`) stay green before and after; the on-device unlock the lane drives (`.maestro/02-pin-entry.yaml`, `subflows/unlock.yaml`) is unaffected — same argon2id, same row.

## Acceptance

- The `userPinVerifiers` row object exists in **one** builder; `users.ts writeVerifier` and `harness seedOwnerPin` each only bind the driver/statement (upsert vs plain insert) to it.
- The builder is **typed** (no per-copy `as never` unless the single shared cast is genuinely required by Kysely's column type).
- `@bolusi/server` + `@bolusi/harness` suites green before and after; the emulator-lane seed path unchanged.
- No new cross-package edge into `apps/mobile`; `@bolusi/harness` stays `"private": true`.
- `pnpm typecheck` / `lint` / `knip` (+0 new) green.

## Note

Contended — touches `apps/server`'s auth route AND `@bolusi/harness`. Do NOT fold into 201 (out of its enrollment-seam scope). Extract on its own branch off `origin/main` after 201 merges, then `review-wave`.
