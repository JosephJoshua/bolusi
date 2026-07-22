# Decisions — 2026-07-14 (later) — stack pins from verified research

> Follow-up to `2026-07-14-v0-foundation.md`. Every pin below was verified against current library docs/registries on 2026-07-14 (5-agent research sweep; raw findings preserved in workflow output). Authoritative pin table with caveats lives in `08-stack-and-repo.md`; this entry records the *decisions and why*.

## D6 — Client SQLite: @op-engineering/op-sqlite 17.1.2 (resolves Q3)

**What:** op-sqlite with `{sqlcipher: true, performanceMode: true}`, single app-wide connection, behind a thin DB-access wrapper. Client-side Kysely via a custom dialect shim over `kysely-generic-sqlite` 2.0.0 (no official op-sqlite dialect exists).

**Why:** Append-only op log = sustained small-write throughput — op-sqlite's `executeBatch` + reusable prepared statements + JSI path fit exactly; materially lower memory profile matters on 2GB devices (projection rebuilds); SQLCipher key is a first-class `open()` parameter (vs expo-sqlite's string-interpolated `PRAGMA key`).

**Alternatives rejected:** expo-sqlite 57 (first-party, kept as documented swap target behind the wrapper — its `withTransactionAsync` is NOT isolated, would mandate `withExclusiveTransactionAsync`); kysely-expo (SDK-56-locked, single maintainer, binds us to expo-sqlite).

**Risk accepted:** op-sqlite is effectively single-maintainer — mitigated by the wrapper + swap target. Device write benchmark required before freezing throughput numbers (testing-guide gates).

> **Forward note (2026-07-22 — D21): D6 is RATIFIED, ON AN ASSUMPTION.** The write benchmark this pin was owed to (P-2's throughput floor, testing-guide §4.2) is **assumed to pass per D21 (owner ruling, 2026-07-22); unverified on device** — see `decisions/2026-07-22-assume-device-performance-passes.md`. No throughput figure has been observed on the 2 GB reference device; none appears in this repo, and none may be written as though it had (CLAUDE.md §2.1). The pin therefore stands on an accepted assumption, not on a measurement. **The wrapper and the expo-sqlite swap target are unaffected** — they were never contingent on the number and stay exactly as specified above, which is also what leaves a real device free to refute this later. Note the sizing recorded in `ai-docs/OPEN-QUESTIONS.md` §1 is unchanged: expo-sqlite is *slower*, so a throughput failure would not be rescued by swapping.

## D7 — Tenant isolation: forTenant() wrapper + Postgres RLS (resolves Q2)

**What:** Two mandatory layers. (1) `forTenant(tenantId)` Kysely wrapper factory — the only exported query path for tenant tables. (2) Postgres RLS policies `USING (tenant_id = current_setting('app.tenant_id')::uuid)` with **transaction-local** `set_config('app.tenant_id', $1, true)` at the top of every request transaction.

**Why:** Wrapper gives spec-enforceable ergonomics + testability; RLS makes a missed filter fail closed (FR-1039: unscoped query must be impossible). Transaction-local `set_config` is pool-safe; session-level SET leaks tenant context across pooled connections — forbidden.

**Alternatives rejected:** hand-rolled Kysely `transformQuery` AST plugin as the *guarantee* (owning correctness across joins/subqueries/CTEs is a liability; may exist later as a third backstop, with adversarial tests); schema-per-tenant (operational burden at 100+ tenants, complicates migrations).

## D8 — On-device crypto: react-native-quick-crypto 1.1.6, sole provider

**What:** quick-crypto for Ed25519 keygen/sign/verify, sync SHA-256, argon2id PIN KDF (default m=32768 KiB / t=3 / p=1; floor m=19456/t=2/p=1 if device benchmark >300ms). Server/shared/test code: @noble/curves 2.2.0 + @noble/hashes 2.2.0 (RFC 8032-interoperable). Canonicalization: `canonicalize` 3.0.0 (RFC 8785, co-author-maintained); RFC 8785 vectors run in CI on Hermes.

**Why:** Hermes has no JIT — pure-JS crypto is 100×+ too slow on the target device (multi-second KDFs); quick-crypto's OpenSSL path is sub-ms signing, native argon2id lands <300ms at OWASP-band params.

**Rejected:** pure-JS-only (noble) on device — infeasible per Hermes benchmarks; expo-crypto (Promise-per-call digest, no Ed25519/argon2).

> **Forward note (2026-07-22 — D21): D8's open parameter question is RESOLVED — the DEFAULT ships (`m=32768 KiB / t=3 / p=1`). ASSUMED, NOT MEASURED.** Which profile ships was owed to the P-4 device benchmark; owner ruling D21 (`decisions/2026-07-22-assume-device-performance-passes.md`) directs us to proceed as if it passes, so the default holds: **assumed to pass per D21 (owner ruling, 2026-07-22); unverified on device.** No argon2id p95 has been observed on the 2 GB target. The default is the **stronger** of the two profiles, so the assumption lands conservatively — it keeps the harder parameters rather than weakening a security parameter on no evidence. The documented floor `m=19456/t=2/p=1` stays the pre-written fallback if a real device refutes it (`api/02-auth.md` §5.3, which is the decision record). **SEC-AUTH-10 is not discharged**: its acceptance is a committed on-device benchmark artifact, and an assumption produces no artifact — the id stays on the pending allowlist.

## D9 — Server pins

hono 4.12.30, @hono/node-server 2.0.8 (WS built-in — the separate @hono/node-ws is deprecated, never use), @hono/zod-validator 0.8.0, zod 4.4.3, kysely 0.29.3 **exact** (0.x minors break; `Migrator` imports from `kysely/migration`), kysely-ctl 0.21.0, kysely-codegen 0.20.0, **Node 22 LTS** (kysely engines ≥22 supersedes hono's ≥20 floor). Custom gzip-request-decompression middleware required (none first-party) with independent decompressed-size cap (gzip-bomb defense) + adversarial tests.

## D10 — Client platform pins

Expo SDK 57 (RN 0.86, React 19.2), **EAS development builds from day one** (Expo Go cannot exercise push/background services/SQLCipher/quick-crypto). Media upload protocol is **hand-rolled chunked resumable** (FileHandle offset+readBytes + per-chunk PUT) — expo-file-system SDK 57 has no resumable upload, and legacy re-exports on the main entry throw at runtime. Foreground drain loop is the primary upload driver; expo-background-task (15-min floor, OEM-unreliable) is opportunistic retry only. Device signing keys in expo-secure-store (<2KB) — encrypted-at-rest storage, **not** a non-extractable enclave; qualified in security-guide.
