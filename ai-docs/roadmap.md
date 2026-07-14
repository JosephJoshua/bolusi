# Roadmap — what is NOT v0, and the forward shape

> **Owns:** the deferred-work ledger (everything explicitly not in v0, each with the trigger that schedules it), the v1 sequencing sketch, the carried-forward open-questions table with current status, and the drift tripwires that invalidate specs when the world moves. This doc does NOT own any v0 behavior — v0 facts live in the spine docs (05-operation-log, 04-module-contract, api/01-sync) and their peers.
> **Change control:** change this doc first, then the code. Scheduling a deferred item = a new decisions/ entry that moves the row out of §1, never an implementation that quietly starts.

Scope anchor: v0 = Platform Core + Auth + reference module `notes` only (decisions/2026-07-14 D1). Anything not in that sentence is in §1 or is a permanent exclusion. Implementation agents: if a task touches a §1 row, stop — it is out of scope by definition (CLAUDE.md §6 red flags).

## 1. NOT in v0 — deferred ledger

Every row is deliberate. "Trigger" is the condition that moves the item into a brainstorm round; nothing here starts without a decisions/ entry.

| # | Item | Deferred to | Trigger to schedule | Refs / door kept open by |
| - | ---- | ----------- | ------------------- | ------------------------ |
| R1 | Printing layer (BLE thermal on mobile, USB/network on desktop) | v1 | First printing consumer lands (POS receipts, repair intake labels) | D1 exclusion; ARCH-001 §4.6; receipt content rules PRD-006 §3.6 |
| R2 | Onboarding framework (guided tenant/store/user setup) | v1.x | First non-family tenant, or SaaS trial motion | D1 exclusion; ARCH-001 §4.9 |
| R3 | Repair lifecycle module (the vertical) | v1 | Next brainstorm (Q6) | PRD-001; last in §2 sketch — depends on inventory, finance, POS, CRM |
| R4 | Inventory module | v1 | Next brainstorm (Q6) | PRD-002; first candidate in §2 sketch |
| R5 | Finance module (CoA, journals, AR/AP, cash reconciliation) | v1 | Next brainstorm (Q6) | PRD-003 |
| R6 | POS module | v1 | Next brainstorm (Q6) | PRD-006 |
| R7 | Owner reporting / dashboards | v1 (minimal) → v1.x (full) | Money-loop projections exist to report on | PRD-005; consumes module queries (04-module-contract §6) |
| R8 | HR — attendance | v1.x | Sequencing brainstorm after money loop | PRD-007 §1–8 (attendance only; payroll is R16) |
| R9 | Delivery module (manifests, POD, driver flow) | v1.x | Sequencing brainstorm | PRD-008; wholesale goods only — repaired-phone delivery is permanently out (00-product-overview) |
| R10 | Chat module | v1.x | Owner appetite confirmed (Q7) | PRD-010 |
| R11 | CRM module (customers, tiers) | v1 | With POS/repair (both depend on it — see §2) | ARCH-001 §6 (`@mod/crm`; no standalone PRD — needs its own brainstorm) |
| R12 | GPS **continuous** tracking service (background location, geofencing) | v1.x | Delivery/attendance modules need it; geofence radii answered (Q7) | PRD-009. NOTE: per-op location stamping IS v0 — the envelope `location` field (05-operation-log §2.1) ships now; only the continuous background service is deferred |
| R13 | Desktop client | Post-v0, unscheduled | Desktop work scheduled → decide Q1 first | Decisions D2 (owner leans Tauri, doubts react-native-web); ARCH-001 §7 parity table is the forward shape; shared TS core packages keep every option open |
| R14 | Global projection snapshots | v1 | Measured on-device: full rebuild or entity re-fold exceeds budget on 2GB Android with realistic history | 04-module-contract §4.3 (OQ-1101): per-entity re-fold bounds v0 cost; the `applied_server_seq`/`applied_local_seq` watermark design is the reserved snapshot hook. Do not "fix" ad hoc |
| R15 | Cross-store sync scope (multi-store owner pull, per-scope cursors) | v1 | Owner dashboard / cross-store reporting work starts | api/01-sync §4.1 (OQ-1103): v0 pull is single-store; cursor is opaque to clients precisely so per-scope cursors can land without a wire break. Staleness display rule for cross-store views already fixed (api/01-sync §7, FR-1135) |
| R16 | Payroll | Pending owner decision — NOT scheduled | Owner answers PRD-007 OQ-601..604 (option A–D); figures re-verified (§4 tripwire T7) | PRD-007 §9: recommendation is A (attendance-only export). Options B–D each need their own decisions/ entry. A half-compliant payroll is worse than none |
| R17 | Tax: e-Faktur / PPN / faktur pajak | SaaS-tier, only if a tenant is PKP | A tenant crosses the Rp 4.8B PKP threshold or registers voluntarily | PRD-006 §11: non-PKP struk has no mandated format; e-Faktur is online-only by nature and conflicts with offline-first — own module, never inside POS. PPN stays optional, disabled by default (PRD-003 §3.9) |
| R18 | Executable reversals / undo (`buildReversal`) | V2 | Agent mode (R19) scheduled | 05-operation-log §7: v0 ships the **mandatory** human-readable `reversal` registry field (04-module-contract §3); the executable hook slots in without contract change. Retrofitting is forbidden by construction |
| R19 | Agent mode (LLM abstraction, rollback machinery, RAG, agent UI, proactive insights) | V2 | Own brainstorm; PRD-004 re-confirmed (stale) | ARCH-001 §9.6 non-goals. Door kept open by the five v0 obligations in §1.1 below |
| R20 | Video capture in media pipeline | v1.x+ | A module PRD requires video evidence AND bandwidth/storage budget is re-reviewed | Media v0 = photos + signatures only (06-media-pipeline). Chunked-upload design must not assume photo-sized payloads forever |
| R21 | Tenant suspension (`Tenant.status` active/suspended) | v1+ | SaaS billing / tenant-suspension work is scheduled | Deferred per 03-state-machines §13: v0 ships no status column (10-db-schema §4) and no suspension semantics (01-domain-model §3.1). Adding it later = a migration + a new machine registration in 03 |
| R22 | Store switcher + multi-store active-store context (FR-1034) | v1 | Rides with R15 — non-functional until cross-store pull scope lands | v0 rule (pinned): `ctx.storeId` = the enrolled device's store, ALWAYS (02-permissions §5.2; 04-module-contract §5.2). ui-labels `auth.switchStore` is annotated v1 |
| R23 | Local op-log retention window on device (OQ-1102) | v1 | On-device storage telemetry shows pressure, or archive/snapshot work (R14) schedules it | v0 rule: devices retain ALL local history — nothing is pruned (05-operation-log). SEED-200K sizing supports about a year of history, not indefinitely |
| R24 | Per-user push targeting + notification preferences (FR-1149/FR-1150) | v1 | First user-personal notification consumer lands | api/04-push: v0 pushes address DEVICES (shared-device reality); muting is a per-category, per-device, client-side boolean. Per-user routing needs user-to-device presence tracking |
| R25 | Server-side permission audit of ALL pushed ops | v1 | Fraud-review tooling work starts, or a hostile-insider incident review demands it | 02-permissions §4: v0 server-validates ONLY the privileged auth ops (`auth.pin_changed` / `auth.pin_reset` / `auth.pin_lockout_cleared` — the 05-operation-log §9 extension list); the general audit is deferred, not rejected |
| R26 | Device signing-key rotation-in-place | v1 | A security review or key-compromise incident requires rotation without losing device identity/history | v0 rotation = revoke + re-enroll as a NEW device (api/02-auth). Rotation-in-place needs versioned keys in the devices directory + pull-verification support for old-key signatures |
| R27 | User photo management UI (upload / change / remove) | v1 | Owner asks for it, or the first personalization pass | `photoMediaId` ships in the user directory from day one (01-domain-model §4.1; api/02-auth §5.2 bundle) so no migration is needed; v0 ships NO upload UI — the user switcher renders initials fallback (design-system §8.2) |

Permanent exclusions (not deferred — do not build, do not drift): vouchers / store credit / loyalty, voice input, repaired-phone delivery, facial recognition / behavioral analysis, custom BI / query builders. Owned by 00-product-overview §"Explicitly OUT"; listed here only so nobody mistakes them for missing rows.

### 1.1 Agent-mode door: five v0 obligations (restated from ARCH-001 §9)

R19 stays cheap only if v0 honors these now. They are **acceptance criteria for v0 code**, not future work:

| Rule | v0 obligation | Owning spec |
| ---- | ------------- | ----------- |
| Pure commands | Command handlers are pure: no UI, no I/O beyond `ctx.query`, no `Date.now()`; output = op drafts + typed result | 04-module-contract §5.2 |
| Granular permissions | One permission string per command/query (`notes.create` grain, never "can use notes"), enforced in the runtime, fail closed | 04-module-contract §5.1; 02-permissions |
| Audit fields | `source`, `agentInitiated`, `agentConversationId` in every signed core from op #1 | 05-operation-log §2.1 |
| Reversal docs | `reversal` description mandatory on every registered op type | 05-operation-log §7; 04-module-contract §3 |
| Queryable projections | Queries are typed, permission-checked, cursor-paginated, programmatically callable (not hook-only) | 04-module-contract §6 |

If a review finds v0 code violating any row, that is a spine violation, not a style nit.

## 2. v1 sequencing sketch — NOT DECIDED

> **Status: sketch only.** The next brainstorm round (Q6) decides money-loop composition and order, with fresh owner input; each module's PRD is stale input to be re-confirmed (CLAUDE.md §0). Nothing below authorizes implementation.

Candidate order for the money loop (D1's rejected-for-v0 alternative, revived as v1), derived from the ARCH-001 §6 dependency map:

| Order | Module | Rationale |
| ----- | ------ | --------- |
| 1 | Inventory | Leaf-most business module — depends only on Platform Core. Products/stock are hard dependencies of POS and repair. Largest projection volume → stresses rebuild/snapshot economics early (feeds R14 trigger) |
| 2 | Finance | Consumed by POS, repair, supplier, inventory (ARCH-001 §6). Journal-entry op types must exist before POS can emit them |
| 3 | POS | Composes inventory (stock movements) + finance (journals, AR). First printing-layer consumer → schedules R1. Needs CRM (customers/tiers) — slot R11 before POS or start it stubbed; brainstorm decides |
| 4 | Repair vertical | Uses everything above plus CRM (ARCH-001 §6). Building it last means it lands on proven module seams |

Unplaced: supplier module (creates AP in finance — likely rides with finance or POS), minimal owner dashboard (PRD-005, after first projections exist). The 00-product-overview v1 row lists the same four modules; the listing order there is not a sequencing claim.

Serialization constraints that shape any chosen order (CLAUDE.md §4 — these are invariants, not preferences):

- Contended shared code serializes: op-type registry additions, permission registry, shared types/contracts, design system, i18n catalog — one agent at a time, landed before dependents start. Each module's manifest (ops + permissions + projection migrations) is therefore a serial gate; only its screens/queries/tests fan out in parallel afterwards.
- DB migrations serialize globally: two modules' projection migrations never run in parallel waves — another reason the module order is strict even if teams are parallel.
- Module code in different areas is parallel-safe: e.g. inventory screens can proceed while the finance manifest is being authored, as long as neither touches shared packages.

## 3. Open questions — carried forward from decisions/2026-07-14

| # | Question | Status 2026-07-14 | Resolution / next step |
| - | -------- | ----------------- | ---------------------- |
| Q1 | Desktop client approach (Tauri shell + which UI layer) | **OPEN** | Decide when desktop work is scheduled (R13). Owner leans Tauri; shared TS core keeps options open |
| Q2 | Tenant isolation mechanism detail | **RESOLVED** (stack research 2026-07-14) | Two mandatory layers: (1) `forTenant(tenantId)` wrapper factory returning a tenant-bound Kysely handle — the ONLY exported way to query tenant tables; (2) Postgres RLS `USING (tenant_id = current_setting('app.tenant_id')::uuid)` with transaction-local `set_config('app.tenant_id', $1, true)` at the top of every request transaction. Session-level `SET` on pooled connections is forbidden (leaks tenant context). Normative detail lives in 10-db-schema §6 + 08-stack-and-repo §3.2 |
| Q3 | Expo SQLite binding | **RESOLVED** (stack research 2026-07-14) | `@op-engineering/op-sqlite` 17.1.2, package.json flags `{sqlcipher: true, performanceMode: true}`, EAS dev builds (no Expo Go). Hard rule: SINGLE connection per DB app-wide. Thin DB-access wrapper keeps expo-sqlite a swap target (op-sqlite is single-maintainer). Kysely on device via custom shim over kysely-generic-sqlite 2.0.0 — no official op-sqlite dialect exists. Normative pins live in 08-stack-and-repo §2; client DDL in 10-db-schema §9 |
| Q4 | Device signing key management (provisioning, storage, revocation, rotation) | **MOVED TO SPEC** | Storage substrate resolved by research: expo-secure-store, values < 2KB, encrypted-at-rest but NOT a non-extractable-key enclave (app code can read keys back — never claim "hardware-backed" unqualified). Enrollment/revocation flows and the adversarial checklist are owned by api/02-auth + the security checklist (CLAUDE.md §2.5) |
| Q5 | PRD-012 OQ-1101..1105 (snapshot cadence, retention, sync scope, sync triggers, media pruning) | **PARTIALLY RESOLVED** | OQ-1101 snapshots → deferred to v1, hook reserved (R14; 04-module-contract §4.3). OQ-1103 sync scope → v0 rule fixed, cross-store deferred (R15; api/01-sync §4.1). OQ-1104 triggers → resolved (api/01-sync §5). OQ-1102 local history retention → v0 rule fixed: retain everything (05-operation-log); the retention window itself is deferred (R23). OQ-1105 media pruning → owned by 06-media-pipeline §7 |
| Q6 | Module sequencing after v0 | **OPEN** | Next brainstorm round. §2 above is the input sketch, not the answer |
| Q7 | Business questions for owner (6-angle photo defaults, PKP status, payroll A–D, geofence radii, retention windows, chat appetite…) | **OPEN** | Batched into each module's brainstorm. PKP status gates R17; payroll A–D gates R16; geofence radii gate R12 |

(PRD-012 OQ-1106 — realtime worth it? — was already resolved into v0: realtime + push are foundation scope. Both are specified: push in api/04-push.md, the realtime channel in api/00-conventions §12. Only the R24 preference/targeting layer is deferred.)

## 4. Drift tripwires — re-verify before you trust the spec

Conditions that silently invalidate spec claims. On hitting a tripwire: stop, re-verify against current docs (CLAUDE.md §1), and update the owning spec doc BEFORE code.

| # | Tripwire | Why it invalidates specs | Required action |
| - | -------- | ------------------------ | --------------- |
| T1 | Expo SDK bump (57 → 58+) | op-sqlite versions independently of Expo — its RN compat table must be re-checked per SDK. If the DB wrapper is ever swapped to expo-sqlite, note expo-sqlite is SDK-version-locked and kysely-expo majors track Expo SDK majors — all three move in lockstep. quick-crypto's Expo config plugin and expo-file-system's File/FileHandle API must be re-verified (in SDK 57 the legacy re-exports on the main entry THROW at runtime) | Re-run the compat checks; update the client-platform spec; re-run RFC 8785 vectors and crypto smoke tests on the new Hermes |
| T2 | kysely version bump | 0.x minors are breaking (0.29.0 alone moved `Migrator` to `'kysely/migration'` and raised the TS floor to 5.4; engines require Node >= 22). Spec pins **0.29.3 exact, no caret** | Read release notes in full; re-run kysely-codegen; re-verify the forTenant wrapper and dialect shim compile |
| T3 | @hono/node-server bump | 2.x is a young major (2.0.6–2.0.8 already fixed header/serve-static regressions); WebSocket support lives IN node-server 2.x | Changelog review before any bump. Never install `@hono/node-ws` — it is DEPRECATED, but pre-2026 tutorials (and model training data) still cite it |
| T4 | zod duplicate in lockfile | @hono/zod-validator 0.8.0 targets zod v4; a transitive zod v3 breaks validator types silently | Lockfile check for duplicate zod majors on every dependency change |
| T5 | canonicalize / JCS change | Envelope `hash` = SHA-256 over RFC 8785 output (05-operation-log §3) — any serialization drift forks every chain | Pin canonicalize 3.0.0 exact; RFC 8785 test vectors run in CI **on Hermes** (JCS number formatting depends on spec-correct number-to-string); client and server must import the same `@bolusi/core` implementation |
| T6 | argon2id params frozen without device data | Defaults (m=32768 KiB, t=3, p=1, 32-byte output) come from desk numbers + vendor benchmarks | On-device benchmark on the 2GB Android target before freezing; documented floor m=19456 KiB / t=2 / p=1 if > 300ms. Never a pure-JS KDF on device |
| T7 | Indonesian tax / payroll figures age out | PRD-006 §11 and PRD-007 §9 figures were verified mid-2026 and change annually (PMK 168/2023 method, PP 20/2026, JP ceiling re-indexing, provincial minimum wages, BPJS caps) | Full re-verification with current regulation — ideally a specialist — before the R16/R17 brainstorms. Stale figures must never be copied into a module spec |
| T8 | Anything relying on expo-background-task timing | 15-min WorkManager floor, OS-controlled cadence, effectively unpredictable on cheap OEM Android skins | Any spec or SLA that depends on background execution is invalid by construction — foreground drain loops are the primary driver (api/01-sync §5(d); 06-media-pipeline); background is opportunistic bonus only |
| T9 | "Hardware-backed key" claims | expo-secure-store is encrypted-at-rest storage; keys are extractable by app code; StrongBox/TEE backing is device-dependent and not exposed | Any doc/test/marketing claim of non-extractable or guaranteed-hardware keys is wrong — qualify it or build a native Keystore module (a scheduling decision, not a drive-by) |
