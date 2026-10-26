# Architecture and current limits

This is a map to the implementation, not a second schema/API registry. Versions
live in manifests and the workspace catalog; tables live in migrations and types.

## Data flow

Mobile persists work in SQLite. Commands check local permissions and produce
append-only operations, canonicalized, hashed, chained per device, and signed.
Projections derive queryable state. Sync pushes pending operations and pulls
accepted ones. The server verifies device identity, scope, signatures and chain
continuity, and persists operations in PostgreSQL. Replay must not duplicate effects.

| Concern               | Implementation                                                                  |
| --------------------- | ------------------------------------------------------------------------------- |
| Registered modules    | `packages/modules/src/index.ts`                                                 |
| Commands/runtime      | `packages/core/src/runtime`, `packages/core/src/module`                         |
| Wire format/integrity | `packages/schemas/src`, `packages/core/src/crypto`, `packages/core/src/oplog`   |
| Sync/projections      | `packages/core/src/sync`, `packages/core/src/projection`                        |
| Server acceptance     | `apps/server/src/oplog`, `apps/server/src/sync`                                 |
| HTTP routes           | `apps/server/src/app.ts`, `apps/server/src/routes`                              |
| Local bootstrap       | `apps/mobile/src/bootstrap`                                                     |
| Identity/permissions  | `packages/core/src/auth`, `packages/core/src/authz`, `apps/server/src/identity` |
| Media                 | `apps/mobile/src/media`, `apps/server/src/media`                                |
| Translations          | `packages/i18n/catalogs`, module screen catalogs                                |
| Search                | `packages/core/src/search`, each module's `search.ts`                           |

Search is shared: modules declare a `SearchSource` (what to load, which entity
changes affect it) and query through `searchIndexFor`. Matching is fuzzy for
anything typed (edit distance over names, digits and codes, never exact). On a
device the index lives in memory per store, loads once, and reloads only the
entities the projection engine reports as changed.

Screens are live the same way: a module's screen reads through `useLiveQuery`
(`packages/modules/src/screen-kit/live.ts`), which re-reads whenever the
projection engine's invalidation bus reports a write to the module's tables, or
a push changes op sync status (`OP_SYNC_STATUS_TABLE`). Local commands and
pulled operations take the same path, so another device's change shows on an
open screen with no extra wiring. A device pushes 1 s after a local change and
pulls on the server's realtime poke, so a colleague's change normally reaches
other screens in the store within a couple of seconds online. A step a user has
open re-checks its ticket against the same rule that offered it and says so when
a synced change has made it impossible to finish.

Shared core runs on Node and mobile Hermes. Native storage, crypto and UI belong
behind adapters. Node tests do not establish native performance or correctness.

## Invariants worth protecting

- Signed history is immutable; corrections are new operations. Sync bookkeeping
  can change without rewriting signed facts.
- Apply operations transactionally and make replay idempotent. Interrupted rebuilds
  and reordered sync must preserve resulting business state.
- A projection version bump rebuilds on the device in the background, re-folding one
  entity at a time from the op log. Appliers write only their own entity's rows, so
  screens and commands keep working while it runs.
- Tenant-bound access and PostgreSQL row-level security isolate tenants. Within a
  tenant, store scope still matters; a store owner is not a tenant administrator.
- Signatures establish device attribution/integrity, not user authorization or
  payment settlement.
- Pending, rejected, and conflicting offline work stays visible and recoverable.
- Money uses integer IDR. Stock receipt, consumption, shipment, and payment are
  distinct events; business modules need direct tests for their effects.
- Preserve evidence integrity and keep credential/PIN material out of projections,
  sync responses, logs, and attachments.

## Limits to carry into repair work

- Platform, auth, Notes and the repair core are registered. Repair has no screens
  yet; inventory and accounting do not exist.
- General pushed business operations are not reauthorized server-side in v0.
  Privileged PIN operations are an exception. High-risk v1 approvals still need
  a server validation/revocation policy covering legitimate offline work.
- Pull scope is tied to the enrolled store. Cross-store workflows require sync
  and authorization work, not just screens.
- Physical 2 GB Android performance was deferred, not measured. Emulator/Simulator
  results are not hardware benchmarks. Signed iOS and physical iPhone verification
  are also still owed.
- First sync on a new device replays the store's whole history; there is no
  snapshot. `pnpm --filter @bolusi/modules bench:first-sync` measures it with
  realistic repair tickets. On a laptop (Node, October 2026), one year at 50
  tickets a day is about 122k ops: about 28 MB gzipped on the wire, about 250 s
  to pull, verify and apply, and a 304 MB device database (555 MB before client
  migration 6 stopped storing each payload twice and compressed the signed text;
  the op log went from 394 MB to 143 MB). Phone timings are still unmeasured; on
  Hermes the compression costs about 0.8 ms per pulled op.
- Op-log values are deflated with a frozen preset dictionary
  (`db-client/src/crypto/compression.ts`). Changing the dictionary makes stored
  ops unreadable; a better one needs a new scheme prefix.
- Local confidentiality uses application-layer encryption; SQLCipher is disabled.
  Old comments/report names do not establish whole-database encryption.
- Extended chaos has unresolved large-workload failures: the recorded October 14
  run hit rate limits in CHAOS-03 and timeouts in CHAOS-08; later nightly runs also
  failed. Removing the schedule does not resolve them. Reproduce a bounded seed
  before attributing a failure to the application or test workload.
- A future rekey/pre-key-tag fleet migration may need verified key-tag backfill.
  It was deferred because current creation tags the DB before enrollment. Add a
  migration when a real upgrade needs it, not to satisfy a historical task entry.

## Server configuration

`apps/server/.env.example` lists configuration names. `DATABASE_URL` selects the
DB; `MEDIA_STORAGE_DIR` needs durable, backed-up production storage.
`EXPO_ACCESS_TOKEN` is required by the production push transport at boot. Tests
inject their transport and need no production push credentials.

`SYSTEM_KEY_DIR` enables server conflict detection. It contains one mode-0600
`system-device-<tenantId>.key` per tenant: a base64 Ed25519 private key created by
tenant provisioning. Unset means detection is off. When enabled, missing/invalid
keys can fail colliding pushes; provision every served tenant before enabling it.
Signers are cached, so restart after changing keys. See
`apps/server/src/sync/system-key-store.ts` and the provisioning CLI.
