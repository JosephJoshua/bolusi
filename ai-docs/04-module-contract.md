# 04 — Module Contract

> **Owns:** the interface every module implements, the command runtime, the projection engine rules, query conventions, and what the v0 reference module must prove. Envelope facts live in `05-operation-log.md`; permission semantics in `02-permissions.md`.
> **Change control:** change this doc first, then code. This contract is what every future module builds against — breaking it after v1 modules exist is a migration project, not an edit.

## 1. Shape

A module is a static manifest in a shared package, imported by BOTH the Expo client and the Hono server:

```ts
defineModule({
  id: 'notes',                          // lowercase, unique; prefixes op types & permissions
  operations: { /* §3 — op type registry */ },
  projections: { /* §4 — tables + migrations, shape in §4.4 */ },
  commands:   { /* §5 — the only write path */ },
  queries:    { /* §6 — typed reads */ },
  permissions: { /* registry entries per 02-permissions §3.1: id, scope, isDangerous, description */ },
  screens:    { /* §7 — RN components, client-only, optional */ },
})
```

Modules communicate via operations and projections only — never direct function calls into another module (ARCH-001 §2.4).

## 2. Two runtimes, one manifest

| Concern | Client (Expo/SQLite) | Server (Hono/Postgres) |
| ------- | -------------------- | ---------------------- |
| Payload Zod schemas | validate before append | validate on push (`SCHEMA_INVALID`) |
| Projection appliers | maintain local read models | maintain server read models |
| Commands | execute locally, offline | not exposed in v0 (no server-initiated writes) |
| Queries | drive UI + future agent | drive future reporting/API |

Appliers are written against `ProjectionDb` — a Kysely instance (SQLite dialect on client, Postgres on server) restricted to a **dialect-neutral subset** (no dialect-specific SQL in appliers; enforced by review + shared test suite that runs every applier against both engines).

## 3. Operation registry

Every op type the module emits is declared:

```ts
operations: {
  'notes.note_created': {
    schemaVersion: 2,
    payload: z.object({ title: z.string().min(1), body: z.string(), mediaId: zUuidV7.nullable() }).strict(),
    payloadByVersion: {         // MANDATORY when schemaVersion > 1 — every superseded version (below)
      1: z.object({ title: z.string().min(1), body: z.string() }).strict(),
    },
    reversal: 'Reversed by notes.note_archived on the same entityId.',   // MANDATORY (05 §7)
    apply: notesApplier,        // §4
    // conflict: { key: 'note.body', severity: 'minor' },  // OPTIONAL — 01 §8.1; absent ⇒ this type never produces a Conflict
    // scope: 'tenant',                                     // OPTIONAL — 01 §6; default 'store' (device's store); 'tenant' ⇒ storeId = null
  },
}
```

- Type string format: `<moduleId>.<entity>_<event-past-tense>`.
- `payload` schemas are `.strict()` — unknown keys rejected. Money fields are integer IDR. No floats (05 §3).
- Bumping a payload shape = new `schemaVersion` + the applier must handle **all** historical versions forever (old ops never disappear) + **retain the superseded version's schema in `payloadByVersion`**.
- `payloadByVersion?: Record<number, ZodSchema>` — **the retained schemas for superseded versions**, keyed by version. **Omitted at `schemaVersion: 1`** (there is nothing superseded); **MANDATORY and COMPLETE for every version `1 .. schemaVersion-1`** once the version has been bumped. Each retained schema is `.strict()` like any other. A key at or above `schemaVersion` is rejected: the current version's schema is `payload`, and a duplicate entry could drift from it. `defineModule` enforces all of this at **import time** — a bump that forgets to retain is a startup failure, not a runtime surprise.
  - **Why retention is part of the contract.** 05 §8 makes the unit of payload validation the pair (`type`, **`schemaVersion`**) — so the server needs a schema for *every* version it can be asked to accept, and since the applier folds `1..current` forever (05 §7), that is every version. With only the current schema retained there were exactly two options and both were wrong: validating an old payload against the *current* schema rejects a legitimate rolling-out old client (a v2 `note_created` carries `mediaId`, which a later `.strict()` refuses), while skipping validation accepts **any** payload at an old version — which then enters the signed, append-only log unvalidated and throws inside the **applier**, where the exception rolls back the whole push transaction as a `500`. That poisons honest sibling ops (security-guide §4.1) and wedges the pushing device, whose client reads a `500` as a transport failure and re-sends the identical batch forever. Retained schemas are the only option that is neither too tight nor open.
  - A version with **no** retained schema fails **closed** — rejected `SCHEMA_INVALID` (05 §8), never accepted unvalidated.
- `reversal` is documentation in v0; executable `buildReversal` slots in for V2 without contract change.
- `conflict?: { key, severity }` — **OPTIONAL**, semantics owned by **01 §8.1** (which frames itself as *extending* this registry entry, the way `permissions` in §1 is owned by 02 §3). It is the only thing that makes two accepted ops on one entity a collision rather than a sequence: the server's Rule-1 detection keys off `(entityId, conflict.key)`. `severity` (`minor | significant`) is **static** per op type (01 §8.3 — v0 has no payload-dependent severity). Absent ⇒ the type never produces a Conflict record.
- `scope?: 'store' | 'tenant'` — **OPTIONAL, default `'store'`**. The envelope scope the op is recorded in (05 §2.1: `storeId` null = tenant-scoped). Declared on the **type** and resolved by `ctx.op()` from this registry — the same rationale as `schemaVersion`: it is a property of the type, not of the emission, and a handler that could state its own scope could record an op in a store it was not authorized in. `'store'` resolves to the device's store (02 §5.2's v0 rule — what every op type got before this field existed, so omitting it is unchanged behaviour); `'tenant'` records `storeId = null`. Required by **01 §6**, which states the *fact* that `platform.user_locale_changed` is tenant-scoped (the preference follows the user to every device) but named no mechanism before this field.

## 4. Projection engine

### 4.1 Rules for appliers

1. **Deterministic.** Same ops in ⇒ same rows out. No clocks, no randomness, no I/O beyond `ProjectionDb`.
2. **Entity-scoped writes.** An applier may only write rows keyed by the op's (`entityType`, `entityId`). Cross-entity aggregates are a v1 projection class — not in v0.
3. **Fold semantics.** An applier is a fold step: `apply(db, op, /* ops arrive in canonical order for this entity */)`.

### 4.2 Order-independence (how FR-1118 is satisfied)

The runtime — not the applier — guarantees convergence:

- **Head case** (op is canonically newest for its entity): incremental `apply(op)`.
- **Out-of-order case** (op sorts before an already-applied op for that entity, per canonical order `(timestamp, deviceId, seq)` — 05 §4): runtime deletes the entity's projection rows and **re-folds** that entity's full op history in canonical order.

Appliers therefore never see out-of-order input. This is the load-bearing trick of the whole engine and gets its own chaos harness coverage (testing-guide).

### 4.3 Rebuild, watermarks & snapshots

- **Full rebuild** (the correctness escape hatch, FR-1116): drop the module's projection tables, replay all ops in canonical order. Must work on a 2GB device with realistic history — exit-criterion tested.
- **Watermarks** (per projection): `applied_server_seq` = highest **contiguous** `serverSeq` applied from pull; `applied_local_seq` = highest local `seq` applied at append. Both strictly monotonic. The out-of-order re-fold (§4.2) is entity-local and does **not** move watermarks. Watermarks answer "is this projection caught up?", nothing else.
- **Rebuild resume**: rebuild iterates the canonical-order index (`timestamp, deviceId, seq` — 05 §4), checkpointing a separate `rebuild_cursor` (the last canonical triple applied). Interrupted rebuilds resume from it. Server-side, projections apply synchronously inside the push transaction, so its `applied_server_seq` is rebuild bookkeeping only.
- Global snapshots (OQ-1101): **deferred to v1** — per-entity re-fold bounds the common cost; the watermark design leaves the snapshot hook open. Recorded here so nobody "fixes" it ad hoc.

### 4.4 Projections manifest shape

```ts
projections: {
  tables: {
    notes: {
      columns: { id: 'text', tenant_id: 'text', store_id: 'text', title: 'text',
                 body: 'text', media_id: 'text', archived: 'integer', edit_count: 'integer',
                 created_by: 'text', created_at: 'integer',
                 last_edited_by: 'text', last_edited_at: 'integer' },   // = 10-db-schema notes DDL, verbatim
      primaryKey: ['id'],
      entityIdColumn: 'id',            // the (entityType, entityId) → rows mapping §4.2 deletes by
      projectionVersion: 1,            // bump forces rebuild on upgrade
    },
  },
  migrations: [/* ordered, both engines — DDL source of truth stays 10-db-schema */],
}
```

The convergence oracle (testing-guide) digests manifest-declared columns in declaration order; undeclared columns are a review failure.

## 5. Commands — the only write path

```ts
commands: {
  createNote: {
    permission: 'notes.create',                    // static declaration → permission registry
    input: z.object({ title: z.string().min(1), body: z.string() }).strict(),
    handler: async (input, ctx) => ({
      ops: [ctx.op({
        type: 'notes.note_created',
        entityType: 'note', entityId: ctx.newId(),
        payload: { title: input.title, body: input.body },
      })],
    }),
  },
}
```

### 5.1 Runtime sequence (the command layer — TASK-CORE-003)

```
execute(command, rawInput, ctx):
  1. input = command.input.parse(rawInput)          // Zod, strict
  2. ctx.requirePermission(command.permission)      // fail closed — 02-permissions
  3. result = command.handler(input, ctx)           // PURE: reads via ctx.query only
  4. runtime completes op drafts with EVERY envelope field per 05 §2.1
     (location via LocationPort.getBestFix() — 08-stack §3.2; null never blocks;
      storeId from the op type's declared `scope` (§3) — the device's store for a
      'store' type, null for a 'tenant' type — resolved from the registry, never
      caller-supplied)
  5. append locally (atomic with 6)
  6. apply projections
  7. schedule sync (debounced)
```

**Sanctioned runtime emissions.** Commands are the only write path — with exactly five lint-enforced exceptions the *runtime itself* appends without a command: `auth.user_switched`, `auth.session_ended`, `auth.permission_denied`, `auth.pin_locked_out`, `auth.device_enrolled`. Nothing else. Adding to this list changes this doc first.

### 5.2 Purity rules (ARCH-001 §9.1 — agent-readiness)

- No UI imports, no toast/navigate, no direct DB writes, no network. Handler output = op drafts + optional typed result.
- Reads only via `ctx.query(module.queries.x, input)` — same query layer the UI uses.
- `ctx` provides: `tenantId, storeId, userId, deviceId`, `op()` draft helper, `newId()` (UUIDv7), `requirePermission()`, `query()`. **No `Date.now()` in handlers** — timestamp is stamped by the runtime for the whole command atomically.
- Errors: throw typed `DomainError(code, message)` — mapped to UI copy via the label catalog (`core.errors.<CODE>`), never hardcoded strings.

### 5.3 DomainError code registry (closed set; extend here first)

`INVALID_TRANSITION` · `PERMISSION_DENIED` · `VALIDATION_FAILED` · `ENTITY_NOT_FOUND` · `NOT_AUTHENTICATED` · `DEVICE_NOT_ENROLLED` · `USER_DEACTIVATED` · `PIN_RATE_LIMITED` · `PIN_LOCKED` · `LAST_ADMIN_PROTECTED` · `ROLE_IN_USE` · `NETWORK` (client transport only). Every code has a `core.errors.<CODE>` row in ui-labels (07-i18n CI gate).

## 6. Queries

```ts
queries: {
  listNotes: {
    permission: 'notes.read',
    input: z.object({
      filter: z.object({ archived: z.boolean().optional() }).optional(),
      sort: z.enum(['createdAt.asc','createdAt.desc']).default('createdAt.desc'),
      cursor: z.string().optional(), limit: z.number().int().max(100).default(50),
    }),
    handler: async (input, qctx) => ({ rows, nextCursor }),
  },
}
```

- Cursor pagination everywhere (no offsets). Programmatically callable — this is the surface the V2 agent and reporting will consume (ARCH-001 §9.5).
- Permission-checked like commands; data-gating (e.g. column-level hiding) happens **in the query handler**, never in the UI (FR-1029).
- `qctx` interface: `{ db: ProjectionDb /* read-only */, tenantId, storeId, userId, hasPermission(id): boolean }`.

## 7. Screens

RN components; read via `useQuery(...)` (live-updating on projection change), write via `useCommand(...)`. Screens never touch `ProjectionDb` or the op log directly. All user-facing strings via the label catalog (07-i18n).

**Live-query invalidation rule:** after ops apply, re-run subscribed queries whose module's declared projection tables (§4.4) intersect the tables written by the applied ops' modules. Per-table granularity; no row diffing in v0.

## 8. What the reference module must prove (v0 exit criterion D4)

A deliberately trivial module (`notes`: create / edit body / archive) that exercises every contract seam:

- [ ] ≥ 3 op types incl. one with `schemaVersion: 2` migration mid-history
- [ ] Command with permission denial path (user without `notes.create`)
- [ ] Projection converges under chaos harness reorder/replay (§4.2 both cases)
- [ ] Full rebuild on-device with seeded realistic history
- [ ] Query pagination + live UI update on pulled remote op
- [ ] Two devices, both offline, both edit same note → merge converges identically on both
- [ ] i18n: zero hardcoded strings; ID/EN toggle works
- [ ] One op carries a media attachment (exercises media pipeline reference — 06-media-pipeline)

If building `notes` reveals contract friction, **this doc changes first**, then the runtime, then the module.
