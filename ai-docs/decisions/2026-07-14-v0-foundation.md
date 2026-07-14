# Decisions — 2026-07-14 — v0 scope, stack, exit criteria

> From `brainstorm-prd` session "v0". PRDs treated as stale input; each decision re-confirmed with the owner.

## D1 — v0 = Foundation proof, no business modules

**What:** v0 builds and proves Platform Core + Auth only: operation log (signed, hash-chained, append-only), projection engine (incremental, order-independent, rebuildable, snapshot-backed), sync engine (push/pull, resumable, incremental, tenant/store-scoped), offline PIN auth + device enrollment/revocation, tenant isolation, conflict detection + staleness indicators, media pipeline (offline capture → compress → chunked resumable upload, immutable metadata), i18n scaffold (externalized strings + lint rule, ID/EN), push notifications + realtime transport (polling fallback).

**Excluded from v0:** printing layer, onboarding framework, every business module.

**Why:** PRD-012 — "if Platform Core is wrong, every module inherits the wrongness." Foundation failures must surface before module code is written against them.

**Alternatives rejected:**
- *Money loop first* (foundation + inventory/POS/finance/repair): faster to user value, but bets all module work on unproven sync/op-log architecture.
- *Repair pilot only:* stubs the accounting/inventory automation the architecture assumes.
- *Full V1 in one push:* biggest batch, slowest feedback.

## D2 — Client: Expo React Native, Android-first

**What:** One Expo RN codebase targeting Android (the constraint device, 2GB RAM). Business logic in shared TS packages consumable by any future client.

**Why:** Most users are mobile; richest native ecosystem for camera/GPS/BLE-printing/SQLite; TS end-to-end.

**Alternatives rejected:**
- *Tauri everywhere:* mobile plugin ecosystem thinner; Rust core splits the codebase.
- *Two clients per ARCH-001 (Tauri desktop + RN mobile):* double UI maintenance; premature — desktop not needed for v0.
- *PWA:* fights BLE printing, background sync, storage persistence on Android browsers.

**Open:** Desktop approach deferred. Owner leans Tauri and doubts react-native-web quality. Decide when desktop work is scheduled; shared TS core keeps all options open.

## D3 — Server: Node + Hono + PostgreSQL + Kysely

**What:** Node LTS runtime, Hono, PostgreSQL (JSONB payloads), **Kysely** query builder (owner's pick over Drizzle), Zod shared schemas, pnpm workspaces monorepo.

**Why:** Boring-reliable where integrity matters (sync server); Hono light and runtime-portable; Kysely's typed builder suits wrapping in a mandatory tenant-scoped query layer (FR-1039: unscoped queries must be impossible to express).

**Alternatives rejected:** Bun runtime (less battle-tested for long-running servers — revisitable, Hono ports); Fastify (heavier, plugin ecosystem not needed for a custom sync protocol); Drizzle (owner preference for Kysely).

## D4 — v0 exit criteria: chaos harness + reference module

**What:** v0 is done when:
1. **Automated harness** passes: multi-device sync simulation; chaos suite — out-of-order arrival, clock skew, interrupted/resumed sync, tampered chains rejected, days-offline merge, idempotent replay; projection rebuild against realistic history volume.
2. **Reference module** — a deliberately trivial vertical (e.g., shared notes / stock-count toy) built against the module contract, running op→projection→sync→UI end-to-end **on a physical 2GB Android device**.

**Why:** Harness proves correctness; reference module proves the module contract is buildable-against — the thing every later module bets on.

**Alternatives rejected:** harness-only (contract ergonomics unvalidated); manual demo (unrepeatable).

## D5 — Timeline: clock reset

**What:** No hard deadline. The "SaaS in 6 months" window from the PRDs is void. Quality-first ordering.

## Open questions (batched — none block v0 start)

| # | Question | Decide when |
| - | -------- | ----------- |
| Q1 | Desktop client approach (Tauri shell + which UI layer) | before desktop work |
| Q2 | Tenant isolation mechanism detail: mandatory scoped Kysely wrapper, +RLS defense-in-depth? | author-ai-docs (spec) |
| Q3 | Expo SQLite binding: expo-sqlite vs op-sqlite (verify current docs) | author-ai-docs (spec) |
| Q4 | Device signing key management: provisioning, secure storage, revocation, rotation | author-ai-docs (security checklist) |
| Q5 | PRD-012 OQ-1101..1105: snapshot cadence, local history retention window, sync scope per role, sync triggers, media pruning window | author-ai-docs (spec) |
| Q6 | Module sequencing after v0 (money-loop composition & order) | next brainstorm round |
| Q7 | Business questions for owner (6-angle photo defaults, PKP status, payroll option A–D, geofence radii, retention windows, chat appetite…) | respective module brainstorms |

Note: PRD-012 OQ-1106 (is realtime worth it for V1) resolved — owner opted realtime+push INTO v0 foundation.
