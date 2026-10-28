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
| Device core           | `packages/device` (boot, runtime, PIN session, sync, media queue; phone + PC)   |
| Identity/permissions  | `packages/core/src/auth`, `packages/core/src/authz`, `apps/server/src/identity` |
| Media                 | `packages/device/src/media`, `apps/server/src/media`                            |
| Translations          | `packages/i18n/catalogs`, module screen catalogs                                |
| Search                | `packages/core/src/search`, each module's `search.ts`                           |
| Printing              | `packages/core/src/print` (HTML, ESC/P), each module's `print.ts` templates     |

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

Unfinished work is kept per user. Each screen writes its draft (and where the user
was) through `SessionManager.saveWork`, which also stores it sealed in the device's
`user_work` table, so it survives a lock, Android recreating the activity, or the app
being killed. Only that user's next PIN unlock reads it back. Saved work of users who
leave the roster is deleted. Modules get this by publishing drafts into the workspace;
they need no storage of their own.

The phone catalog is global reference data, not ops: Postgres `phone_models`
(no RLS; the app role can only read it), crawled by `apps/server/src/catalog`.
Devices pull rows by `revision` from `GET /v1/catalog/phones` into SQLite
`phone_models` and fetch a photo from `/v1/catalog/phones/:id/photo` only when
shown, keeping it in the evictable cache after checking its sha256. Each row
carries the model's spec sheet (`PhoneSpecs`). Intake model search
(`repair/device-models.ts`) joins it with models this store took in before.

Every `AppShell` lifts its content and bottom action above the on-screen keyboard
and scrolls a focused `TextInput`/`SearchField` into sight (`ui/src/shell/keyboard.tsx`);
Android is edge to edge, so the window no longer resizes for the keyboard.

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
- The server is the authority. Devices sync signed events, and every change type
  declares a permission and a `rule` (a legal state change, a target in this
  store, values only this device may mint, or `null` with a reason). The device
  runs both before saving; the server runs both again against its own records and
  refuses what fails. The device then re-folds the record without the refused
  change and lists it under sync problems.
- A change stamped more than 10 minutes ahead of the server clock is refused, so
  a wrong clock cannot win last-writer-wins. A device whose last sync found its
  clock that far ahead saves nothing until the clock is fixed.
- Pending, rejected, and conflicting offline work stays visible and recoverable.
- A phone whose token the server refuses (401 `AUTH_TOKEN_INVALID`) 3 times over
  10+ minutes stops syncing (`device_unrecognised`) but keeps working; the sync
  screen offers re-enrolment. Re-enrolling a phone that holds a store's data binds
  it to that store only, and its unsynced changes are re-signed under the new
  device after one `auth.device_changes_transferred` record
  (`packages/core/src/auth/carry-over.ts`), keeping their ids, authors and times.
  The server checks each one like any other push; one it already holds comes back
  `duplicate` and still uses up its chain position. A value an earlier registration
  minted offline (a ticket number) stays valid: rules ask `carriedRegistrations`,
  which follows the transfer records. The open session ends before the bind, and
  sync restarts under the new device as soon as the bind succeeds. Synced changes a
  restored server lost are not re-sent.
- Money uses integer IDR. Stock receipt, consumption, shipment, and payment are
  distinct events; business modules need direct tests for their effects.
- Preserve evidence integrity and keep credential/PIN material out of projections,
  sync responses, logs, and attachments.

## Adding a module or change type

These rules hold for every module. Most are checked by code, so a missing piece
fails a build, a boot or a test rather than waiting for review:

- Register the module once in `ALL_MODULES`; the server and the phone both fold from it.
- `defineModule` refuses a manifest whose op type is not past tense, whose payload
  schema is not `.strict()`, or which lacks a reversal note, an applier or retained
  schemas for older versions.
- Every op type declares its `permission`, its `entityType` and its `rule`: what
  must hold in the records for it to be recorded (`module/op-rules.ts`), run by the
  device before saving and by the server before accepting a push. `null` is only for
  a type nothing in the records constrains. A module with rules lists its refusal
  reasons with `defineRefusals`, and each reason needs id and en copy at
  `<module>.refusal.<reason>` (`apps/mobile/test/refusal-copy.test.ts`).
- When a type's rule judges only newer versions, set `minPushVersion` on the type. The
  server refuses a new push below it as `SCHEMA_INVALID`; stored ops still fold at every version.
- A change that lowers what a customer owes (a price, a down payment, a fee) needs
  an owner-only permission, checked in the type's `permission` or its `rule` with
  `holdsPermission` (repair's `requireDiscountPermission`), so the server refuses it too.
- Every op type needs a label (`apps/mobile/test/op-type-labels.test.ts`). Every
  error and rejection code needs id and en copy (`pnpm i18n:check`).
- Every op type a device can push needs a sample in
  `apps/server/test/integration/sync/every-op-type-folds.test.ts`, which pushes it
  through the real pipeline on PostgreSQL. An applier that Postgres refuses fails the
  whole push, and the device would resend that batch forever.
- Screens read through `useLiveQuery` (`screen-kit/live.ts`). The platform adapter
  subscribes the module runtime to the module's tables, so a pulled change re-runs
  every open read.
- Counter PC screens live in `src/<module>/desktop/`. The PC's stylesheet picks up their
  classes from that folder, and the PC window is told every module's permissions
  (`apps/desktop/src/core/permissions.ts`), so a new module needs no PC wiring for either.
- Typed search goes through a `SearchSource` and `searchIndexFor`, which match fuzzily.
- A step that stays open (a form, photos, a signature) re-checks its target against
  the same rule that offered it, and says why it can no longer finish. See repair's
  `staleStep` in `flows.ts` and the `stale` prop on `FlowScreen`.

## Money

The `money` module (`packages/modules/src/money`) owns the ledger. Other modules
never write its tables: their commands add money ops (`chargeOp`, `paymentOp`,
`refundOp`) next to their own ops, and each money op's applier posts balanced
lines from `postings.ts`. A line on `receivable` names its document, so a
document's balance is a sum (negative while paid ahead). A module that charges
customers registers a document source (`money/documents.ts`) in
`packages/modules/src/index.ts`; the charge rule asks it for the exact amount.

The server judges each pushed op alone, not a command's ops as a group, so each
money rule is safe on its own: a charge equals the document's price, a refund by
the counter returns at most the overpayment through the account it came in by,
and lowering a bill, voiding a payment or settling a cash difference are owners'.
A cash count records what was counted; the difference is computed against the
book at the count's time, so late-synced cash shows up correctly. Stock and
purchasing post through the same module (reserved accounts in `constants.ts`).

## Limits to carry into repair work

- Platform, auth, Notes and the repair core are registered. Repair has no screens
  yet; inventory and accounting do not exist.
- Every op type declares the permission its author needs and the record kind it
  writes. The server checks each pushed op with the same `evaluatePermission`
  the device runs, against the server's roles in the device's store. A refused
  op is stored in `refused_operations`, still uses up its place in the device
  chain (so later ops keep syncing), and gets the same answer when pushed again.
  A deactivated user's unsynced ops are all refused, and an op is only credited
  to an employee of the device's store (PINs are verified on the device, so
  within a store the device's claim of who is signed in is trusted). Refused
  positions leave gaps in a device's logged chain that `refused_operations`
  (seq and hash) accounts for. Each refusal carries a reason the module
  declares (`defineRefusals`), with its own copy in every language.
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
- Board volume: `pnpm --filter @bolusi/modules bench:board` times the board's
  reads on a device holding a store's history, and `apps/mobile/e2e-web/board-perf.mjs`
  times the board itself in throttled Chromium (`?tickets=N` fills the web demo).
  Screens must keep lists windowed: the `AppShell` content slot is fixed in height
  so a `List` only renders what is near the screen, and rows should be memoized.
  The first search of a session builds the search index (about 0.25 s on a laptop
  for 5k tickets, roughly 1 s or more expected on a cheap phone; unmeasured there).
- Server sync capacity (`bench:sync-load`, one Node process on one core, Postgres
  16 on two cores, October 2026). A busy hour is light even at 1,000 stores and
  4,000 devices: push p50 about 100 ms, and changes reach the store's other
  devices within 0.1 s at p95. The limit is ingest: each change is about 13
  sequential statements under the tenant's counter lock, so one business takes
  about 90 changes a second and one server process about 250. A 100-store
  business reconnecting after two hours offline (23k changes) catches up in
  about 3.5 minutes. Pushes are queued per tenant in memory and at most 6 run at
  once (`apps/server/src/sync/tenant-queue.ts`), so pulls keep their connections.
  Batching the per-change statements is the next lever.
- Op-log values are deflated with a frozen preset dictionary
  (`db-client/src/crypto/compression.ts`). Changing the dictionary makes stored
  ops unreadable; a better one needs a new scheme prefix.
- Local confidentiality uses application-layer encryption; SQLCipher is disabled.
  Old comments/report names do not establish whole-database encryption.
- Extended chaos (`pnpm chaos:extended`) failed from October 14 to 24 in CHAOS-03
  (HTTP 429) and CHAOS-08 (timeout). Both were harness problems, fixed October 26:
  the harness server's fake clock never advanced, so its per-device rate limit
  never refilled, and CHAOS-08's timeout had no room for four workers sharing a
  box. Reproduce a bounded seed before attributing a failure to the application
  or test workload.
- A future rekey/pre-key-tag fleet migration may need verified key-tag backfill.
  It was deferred because current creation tags the DB before enrollment. Add a
  migration when a real upgrade needs it, not to satisfy a historical task entry.

## Server configuration

`apps/server/.env.example` lists configuration names. `DATABASE_URL` selects the
DB; `MEDIA_STORAGE_DIR` needs durable, backed-up production storage.
`EXPO_ACCESS_TOKEN` is required by the production push transport at boot. Tests
inject their transport and need no production push credentials.

`PUBLIC_URL` is the origin clients reach the server at. Cookies are marked `Secure`
unless it is a plain-http origin, so leave it unset or https in production and set it
to `http://<lan-ip>:3000` only for a local server phones reach over plain HTTP.

`TRUSTED_PROXY_CIDRS` lists the reverse proxies in front of the server (addresses or
CIDR ranges, comma-separated). Unset, `X-Forwarded-For` is ignored and per-IP login
limits key by the socket address, which behind a proxy is the proxy's, so all
clients share one bucket. Set it to the proxy's address in production; a request from
it is keyed by the rightmost forwarded address that is not a trusted proxy.

`SYSTEM_KEY_DIR` enables server conflict detection. It contains one mode-0600
`system-device-<tenantId>.key` per tenant: a base64 Ed25519 private key created by
tenant provisioning. Unset means detection is off. When enabled, missing/invalid
keys can fail colliding pushes; provision every served tenant before enabling it.
Signers are cached, so restart after changing keys. See
`apps/server/src/sync/system-key-store.ts` and the provisioning CLI.
