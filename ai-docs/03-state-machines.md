# 03 — State Machines

> **Owns:** every v0 status enum — its values, transition tables, escalation schedules (media retry, staleness thresholds), invalid-transition behavior, and where each machine is enforced. Any doc that mentions a status value references this doc; none may add values or transitions. **Exception:** the PinAuth machine (schedule, thresholds, states, recovery) is owned by api/02-auth §6.5 — §9 mirrors it verbatim. Envelope facts live in 05-operation-log; sync wire behavior in api/01-sync; command/projection semantics in 04-module-contract.
> **Change control:** change this doc first, then the code. A new state value, a new transition, or a changed threshold is a red-flag change (CLAUDE.md §6) — stop and ask before editing.

## 1. Conventions & the dual-enforcement model

- Internal names are lowercase snake_case English (`auto_resolved`, never `Selesai`). UI strings come only from the label catalog (07-i18n); enum values are never rendered raw.
- Persisted machine state is a column on its entity, unless a machine's section states a different realization (§9 derives states from `pin_attempt_state`; §11 derives them from the `archived` boolean). Timestamps are ms-epoch integers; ids are UUIDv7.
- **Single implementation (CLAUDE.md §2.8):** every transition table in this doc is encoded once as const data in `@bolusi/core/state-machines` and imported by both runtimes. A parity test shall assert the code tables equal this doc's tables; drift fails CI.
- **Op-type and command strings are quoted, never restated:** every `type` / command name in this doc is quoted verbatim from its owning registry (01-domain-model §6 and the module specs). A doc-parity lint compares these strings against the registries; a mismatch fails CI — these strings live in an append-only signed log, so a wrong constant is permanent.
- **Two enforcement points, deliberately different:**
  1. **Command-time (preconditions).** A command checks the projected current state before emitting ops. A violation throws `DomainError('INVALID_TRANSITION', {machine, from, event, entityId})` (04-module-contract §5.2) and **no op is created**.
  2. **Projection-time (total folds).** Appliers never reject an op (04-module-contract §4.1 — deterministic, total). A sequence that violates a machine can legitimately arise from offline merge (two devices, both saw a valid precondition). The applier applies the **total rule** given per machine below; where 01-domain-model §8 says so, the sequence becomes a Conflict record (§7) — never an error, never a dropped op.
- Runtime-internal machines (§3, §4, §9, §10) transition only through the shared executor in `@bolusi/core/state-machines`. An invalid `(machine, from, event)` pair throws `DomainError('INVALID_TRANSITION')`: dev builds crash loudly; production logs and leaves the machine unchanged.
- "Terminal" means: no outgoing transitions exist in code. Not "we don't call them" — they are not expressible.

## 2. Enum registry (index — the source of truth)

| § | Machine | Entity.field | Values | Persisted where | Enforced |
| - | ------- | ------------ | ------ | --------------- | -------- |
| 3 | Op sync status | `Operation.syncStatus` | `local` `synced` `rejected` | client DB (bookkeeping, never signed — 05 §2.3) | client runtime |
| 4 | Media upload | `MediaItem.uploadStatus` | `pending` `uploading` `uploaded` `failed` | client DB | client runtime |
| 5 | Device | `Device.status` | `active` `revoked` | server directory row (authoritative); client mirror `device_registry` via the pull devices sidecar (api/01-sync §4) | server (revocation endpoint); client mirror is display + verification input |
| 6 | User | `User.status` | `active` `deactivated` | server directory row (authoritative); client mirror `users_directory` via the device bundle (api/02-auth §5.2) | server (control-plane endpoints); client gates auth from the mirror |
| 7 | Conflict | `Conflict.status` | `detected` `auto_resolved` `surfaced` `acknowledged` | projection, both runtimes | both (conflict engine is deterministic) |
| 8 | Staleness | derived level (not a column) | `fresh` `warning` `stale` | computed from `SyncState.lastSuccessfulSyncAt` | client runtime |
| 9 | PinAuth (PIN lockout) | derived per (userId, deviceId) from `pin_attempt_state` | `unlocked` `delayed` `locked_out` | client DB, **plaintext** (`pin_attempt_state` holds counters/timestamps, no secret — it is not in D22's encrypted set, 10-db §9.7; shape owned by api/02-auth §6.5, DDL 10-db §9.5) | client runtime (machine owned by api/02-auth §6.5; §9 mirrors it) |
| 10 | Sync loop | in-memory loop state | `idle` `pushing` `pulling` `backoff` | in-memory (guards persisted on `SyncState`) | client runtime |
| 11 | Note (reference module) | `Note.status` (realized as the `archived` boolean — §11) | `active` `archived` | projection, both runtimes | command precondition (client); appliers total (both) |

No other v0 status enum exists. §13 lists things that look like machines but are not, and deferred enums.

## 3. Operation.syncStatus

Client-local bookkeeping (05-operation-log §2.3). Never signed, never synced as data, never exists server-side (the server records acceptance in its own tables — `serverSeq`, `receivedAt`).

**Birth states (not transitions):**

| Created by | Born as | Notes |
| ---------- | ------- | ----- |
| Local command append (04 §5.1 step 5) | `local` | atomic with the append |
| Insert via pull (api/01-sync §4) | `synced` | already server-accepted; `syncedAt` = apply time |

**Transitions:**

| From | Event / trigger | To | Side effects | Triggered by |
| ---- | --------------- | -- | ------------ | ------------ |
| `local` | push result `accepted` | `synced` | `syncedAt` set | sync engine, on server response (api/01-sync §3) |
| `local` | push result `duplicate` | `synced` | `syncedAt` set (terminal-success, api/01-sync §3) | sync engine |
| `local` | push result `rejected`, any code of the closed registry in 05 §8 | `rejected` | `rejectionCode` + `rejectionReason` set atomically with the transition; surfaced to the user immediately — never silent (05 §8); if code = `CHAIN_BROKEN`, also set `SyncState.pushHalted = true` (§10). `CHAIN_HALTED` (batch remainder after a `CHAIN_BROKEN` — 05 §8) marks the op `rejected` but does **not** set `pushHalted` again — the preceding `CHAIN_BROKEN` already did. | sync engine |
| `local` | push result `CHAIN_GAP` | `local` (no transition) | not an error — client resends from the gap (api/01-sync §3) | sync engine |

**Terminal:** `synced`, `rejected`. A rejected op is never deleted and never re-pushed — a correction is a **new** operation (05 §1). After `CHAIN_BROKEN`, salvage is re-issuance as new ops under a new enrollment (manual/support path — roadmap); un-rejecting does not exist.

**Invalid:** `synced → rejected`, `rejected → synced`, `* → local` ⇒ `INVALID_TRANSITION`. A repeated `accepted`/`duplicate` response for an already-`synced` op is an idempotent no-op (retry of a partially-acknowledged batch), not a transition.

**Enforced:** client runtime only.

## 4. MediaItem.uploadStatus

Client-side only. The server's chunk-session bookkeeping (which chunks received, finalize state) is owned by `api/03-media.md` and is **not** this enum.

**Birth:** `pending`, at capture-commit — after the captured file is moved from the cache dir to the document dir (06-media-pipeline owns the capture flow; Expo SDK 57 `takePictureAsync` writes to cache, which is purgeable).

**Transitions:**

| From | Event / trigger | To | Side effects | Triggered by |
| ---- | --------------- | -- | ------------ | ------------ |
| `pending` | drain loop selects item (device online) | `uploading` | chunk session opened (`init`) or resumed — **resume position is server-authoritative**: the server's `receivedChunks` (idempotent re-`init` / `GET status`, api/03-media §3.1/§3.3) decides what is left to send; local progress is display-only (06-media-pipeline) | upload engine (foreground drain loop primary; expo-background-task opportunistic — 06-media-pipeline) |
| `uploading` | chunk PUT succeeds | `uploading` (self) | local progress display advanced (display-only — the server's `receivedChunks` is the truth) | upload engine |
| `uploading` | server confirms `complete` (all chunks) | `uploaded` | `uploadAttempts` cleared; prune-eligibility clock starts (retention window owned by 06-media-pipeline); download is by media id (api/03-media §3.5) — no URL is stored | upload engine, on server response |
| `uploading` | chunk/complete failure (network, 5xx, fatal server error) | `failed` | `uploadAttempts += 1`; `lastErrorCode`/`lastErrorMessage` recorded; `nextAttemptAt` per §4.1; if `uploadAttempts ≥ 5`, surface the persistent-failure indicator (PRD-012 §6 "media never uploads") — item stays retryable | upload engine |
| `uploading` | app restart finds no live upload task | `pending` | crash recovery; nothing is re-sent needlessly — the next `uploading` entry re-fetches `receivedChunks` from the server (resume, don't restart) | client startup reconciliation |
| `failed` | `nextAttemptAt` reached · manual retry · connectivity regained | `uploading` | resume from server-reported `receivedChunks`; counters retained | upload engine / user |

**Terminal:** `uploaded`. Pruning the local file after the retention window does **not** change `uploadStatus` — `localPath` is set null, status stays `uploaded`.

### 4.1 Media retry backoff (owned here)

Per-item: `5 s → 15 s → 60 s → 5 min` cap, indexed by `uploadAttempts`. Connectivity-regained resets the backoff: all `failed` items become immediately eligible (`nextAttemptAt` cleared); `uploadAttempts` is retained for the surfacing threshold. Persistent-failure surfacing threshold: `uploadAttempts ≥ 5`; retries continue at the 5-min cap forever — surfacing escalates visibility, never stops retrying. 06-media-pipeline §5.3 cross-references this schedule without restating the numbers.

**Invalid:** `uploaded → *`, `pending → uploaded` (skipping `uploading`), `failed → uploaded` ⇒ `INVALID_TRANSITION`.

**Enforced:** client runtime only.

## 5. Device.status

**Birth:** `active`, when enrollment completes (flow owned by api/02-auth: keypair generated on device via react-native-quick-crypto, private key in expo-secure-store, pubkey registered server-side).

**Transitions:**

| From | Event / trigger | To | Side effects | Triggered by |
| ---- | --------------- | -- | ------------ | ------------ |
| `active` | **directory mutation** via `POST /v1/devices/:deviceId/revoke` (api/02-auth §7 — online-only, control plane) | `revoked` | `revokedAt`/`revokedBy` set on the directory row; `identity_audit` row appended (the audit record — 10-db). Server: device token invalid ⇒ `401`; every op **received after** the revocation is rejected `DEVICE_REVOKED` (receipt-time cut, 05 §8). Ops accepted before revocation remain valid — history stays verifiable (PRD-011 FR-1019). Device surfaced as revoked in the device list. | user holding `auth.device_revoke` (02-permissions §11), or a control session (api/02-auth §7.1) |

**Terminal:** `revoked`. There is no un-revoke. Recovery = a **new enrollment**: new `deviceId`, new keypair, `seq` restarts at 1, fresh chain genesis (05 §2.1). A revoked deviceId or key is never reused.

**Propagation:** the transition is **not** op-sourced — no `auth.*` op carries it. The server directory row is the enforcement truth; clients learn via the pull **devices sidecar** (api/01-sync §4) and replace their `device_registry` mirror atomically. Revoked devices remain listed (their public keys keep verifying history).

**Idempotency:** re-revoking an already-revoked device is an endpoint no-op — same `200` body (api/02-auth §7.1). There is no client command and therefore no command-time `INVALID_TRANSITION` for this machine.

**Enforced:** **server-authoritative** — the server's directory row is what gates push acceptance and token validity; the revoked device itself is untrusted and merely learns via `401` (client reaction: §10 `syncDisabled`; local wipe flow owned by api/02-auth §7.3). The client `device_registry` mirror serves device-list display and pull-side signature verification (api/01-sync §4).

## 6. User.status

**Birth:** `active`, via `POST /v1/users` (api/02-auth §5.4 — **online-only** control plane; no offline user creation, ever). Created only by users whose permission scope covers the target stores — no self-registration (PRD-011 FR-1002).

**Transitions:**

| From | Event / trigger | To | Side effects | Triggered by |
| ---- | --------------- | -- | ------------ | ------------ |
| `active` | **directory mutation** via `POST /v1/users/:userId/deactivate` (api/02-auth §5.4 — online-only) | `deactivated` | `identity_audit` row appended. Removed from the PIN switcher on each device **as its bundle refreshes** (api/02-auth §5.2 — eventual; an offline device is unaffected until it next syncs; PRD-011 §7, accepted property); the local verifier row is deleted with the bundle update. Cached privileged data invalidation per 02-permissions. Every op the user ever signed remains valid and retained — the audit trail never shrinks (FR-1004). | user holding `auth.user_deactivate` (02-permissions §11). **Guard (server endpoint check only — no projection guard, no Conflict):** never the last active tenant-admin ⇒ `409 LAST_ADMIN_PROTECTED` (fail closed; api/02-auth §5.4; PRD-011 §7) |
| `deactivated` | **directory mutation** via `POST /v1/users/:userId/reactivate` (api/02-auth §5.4 — online-only) | `active` | `identity_audit` row appended. Reappears in each device's switcher as its bundle refreshes. PIN unchanged — a PIN reset is a separate flow (api/02-auth §6.6). Prior sessions are not restored. | user holding `auth.user_deactivate` (02-permissions §11 — the endpoint gate covers both directions, api/02-auth §5.4) |

Reversible; no terminal state.

**Normative:** `User.status` gates **authentication and command execution only** — on devices whose bundle reflects it. It never gates op acceptance on push: the server accepts ops from deactivated users (05 §9 checks *tenant membership*, not *active*), because those ops record what actually happened on an offline device, and the fraud model wants that record.

**Propagation:** the transition is **not** op-sourced — no `auth.user_*` op types exist (identity is control-plane directory data; api/02-auth §1). The server directory row is the truth; clients receive it via the device bundle (api/02-auth §5.2) and overwrite their `users_directory` mirror — no fold, no merge, no conflicts.

**Idempotency:** deactivating a `deactivated` user or reactivating an `active` user is handled at the endpoint (api/02-auth §5.4 owns the response). There is no client command and therefore no command-time `INVALID_TRANSITION` for this machine.

**Enforced:** server (control-plane endpoints mutate; 05 §9 scope validation is unaffected). Client-side, the auth runtime gates the switcher and command execution from the `users_directory` mirror.

## 7. Conflict lifecycle

Conflict **detection rules, severity classification, and conflict identity** (`conflictId` derivation) are owned by 01-domain-model §8. This doc owns the lifecycle. Conflict records are projection-class: derived deterministically from the op log, so every device and the server converge on identical records and states.

**Birth:** `detected`, created by the conflict engine when a declared conflict-key rule or a registered Rule-2 invariant check fires after ops merge (01-domain-model §8 — never by sync refusing an op, api/01-sync §8).

**Transitions:**

| From | Event / trigger | To | Side effects | Triggered by |
| ---- | --------------- | -- | ------------ | ------------ |
| `detected` | classified **minor** (rules: 01-domain-model §8) | `auto_resolved` | recorded; feeds reporting (v1); no user action | conflict engine (system), both runtimes |
| `detected` | classified **significant** | `surfaced` | attention item for the store owner; push category `conflict` (api/04-push owns delivery) | conflict engine (system), both runtimes |
| `surfaced` | `platform.conflict_acknowledged` op applied (`entityType: 'conflict'`, `entityId: conflictId`) | `acknowledged` | owner's decision recorded in the op payload; any corrective ops are appended by the same command as separate ops (a correction is a new op — 05 §1) | user holding `platform.conflict_acknowledge` (02-permissions §11) via command |

**Terminal:** `auto_resolved`, `acknowledged`.

- `detected` is transient: classification happens in the same transaction that creates the record. A persisted `detected` row after a crash is re-classified on the next engine run (self-loop event, allowed).
- **Projection-time total rule:** duplicate acknowledgments merged from two devices — first in canonical order wins; later ones fold as no-ops, and are not themselves conflicts.

**Invalid (command-time):** acknowledging an `auto_resolved` or already-`acknowledged` conflict ⇒ `INVALID_TRANSITION`.

**Enforced:** both runtimes (the engine is deterministic; command precondition gates the acknowledgment).

## 8. Staleness

Derived level — **not a persisted column**, recomputed on demand. v0 scope: the local device. Cross-store views (v1+) take the **oldest contributing store's** level, never the local device's (api/01-sync §7, FR-1135).

| Level | Condition (`age` = now − `SyncState.lastSuccessfulSyncAt`, server-relative per api/01-sync §7) | UI class |
| ----- | ---------------------------------------------------------------------------------------------- | -------- |
| `fresh` | `age < 1 h` | quiet |
| `warning` | `1 h ≤ age < 24 h` | banner |
| `stale` | `age ≥ 24 h`, **or never synced** (`lastSuccessfulSyncAt = null`) | loud banner |

Constants in `@bolusi/core`: `STALENESS_WARNING_MS = 3_600_000`, `STALENESS_STALE_MS = 86_400_000`. **This section is the sole numeric source for staleness thresholds** — api/01-sync §7 and the design system reference it without restating the numbers; the numbers change only via this doc.

- `lastSuccessfulSyncAt` is set when a **pull drain completes** (`hasMore = false`, no error — §10). A failed push does not affect staleness; unpushed local work is a separate indicator (the derived `pendingOperationCount` — 01-domain-model §5.2).
- `age` must not trust raw device wall-clock alone: baseline is the `serverTime` captured at the last successful pull plus elapsed time since (api/01-sync §7) — a drifted clock must not fake freshness.
- Recompute on: 60 s UI tick, sync-cycle completion, app foreground. Levels move in both directions; there are no invalid transitions and no typed errors.
- Labels/visuals via 07-i18n and the design system; the level names here are the internal contract.

## 9. PinAuth — PIN rate limiting & lockout

> **Ownership pointer:** this machine — schedule, thresholds, states, recovery, persistence shape — is **owned by api/02-auth §6.5**. This section is its verbatim mirror, kept here so the enum registry (§2) is complete and the code-table parity test (§1) has one canonical machine table. Change api/02-auth §6.5 first; this section follows.

Per **(userId, deviceId)** pair, enforced entirely locally (offline is the normal case). State persists in the client DB table `pin_attempt_state` — `{userId, deviceId, consecutiveFailures, windowStartedAt, notBefore}` (shape: api/02-auth §6.5; DDL: 10-db §9.5) — surviving app restart (SEC-AUTH-03). Clearing it through the APP requires wiping app data, which also destroys the device enrollment and signing key, so that route still costs the attacker the enrollment.

**Consequence of D22, stated because it is a real weakening:** these columns are **plaintext** and the database file is no longer whole-file encrypted, so an attacker with WRITE access to the file (a rooted or unlocked device, out of §1's scope but in reach of the lost/stolen case) can now reset `consecutiveFailures`/`notBefore` **directly**, without touching the enrollment — defeating the SEC-AUTH-03 lockout at no cost. Under SQLCipher this was infeasible without the key. The column classification is signed off (the counters are not secrets and the lockout is a throttle, not a secret-keeper); this is the throttle's honest ceiling, and the controls that still bind are the server-side ones (revocation, `device_anomalies`) plus the fact that a cracked PIN still yields only attributable, device-signed ops. Other users on a shared terminal are never blocked by one user's failures.

The machine's states are **derived from the persisted row**, not stored as a column: `locked_out` ⇔ `consecutiveFailures ≥ 10`; `delayed` ⇔ `3 ≤ consecutiveFailures < 10`; else `unlocked`. Within `delayed`, `notBefore` gates whether an attempt is evaluated at all. The parity test maps states to this derivation.

Every evaluated PIN verification runs argon2id (parameters owned by api/02-auth §5.3). The KDF cost is an intrinsic rate limit **underneath** this machine; no cheap comparison path may exist.

### 9.1 Escalation schedule (mirror of api/02-auth §6.5)

| Consecutive failures | Next attempt allowed after |
| -------------------- | -------------------------- |
| 1–3 | immediately (attempts 1–3 are free) |
| 3 → 4th attempt | 30 s |
| 4 → 5th attempt | 60 s |
| 5 → 6th attempt | 120 s |
| 6–9 → each next attempt | 300 s (cap) |
| **10** | **hard lockout** — PIN auth for this user on this device is disabled; `auth.pin_locked_out` op emitted (api/02-auth §6.3) |

### 9.2 Transitions

| From | Event / trigger | To | Side effects | Triggered by |
| ---- | --------------- | -- | ------------ | ------------ |
| `unlocked` | `pin_failed` (count now 1–2) | `unlocked` | `consecutiveFailures += 1` | auth runtime |
| `unlocked` | `pin_failed` (3rd consecutive failure) | `delayed` | counter := 3; `notBefore = now + 30 s` (§9.1) | auth runtime |
| `unlocked` | `pin_succeeded` | `unlocked` | `consecutiveFailures := 0` | auth runtime |
| `delayed` | `pin_attempt` while `now < notBefore` | `delayed` (no transition) | attempt **not evaluated** — KDF not run (SEC-AUTH-02); `DomainError('PIN_RATE_LIMITED', {retryAt})`; not counted; countdown shown via label-catalog copy | auth runtime |
| `delayed` | `pin_failed` (count now 4–9; evaluated because `now ≥ notBefore`) | `delayed` (self) | counter += 1; `notBefore = now + schedule (§9.1)` | auth runtime |
| `delayed` | `pin_succeeded` | `unlocked` | `consecutiveFailures := 0` | auth runtime |
| `delayed` | `pin_failed` (10th consecutive failure) | `locked_out` | counter := 10; `auth.pin_locked_out` op emitted by the auth runtime (api/02-auth §6.3 — the sanctioned direct append); surfaced on the switcher | auth runtime |
| `locked_out` | `pin_attempt` | `locked_out` (no transition) | not evaluated; `DomainError('PIN_LOCKED')` | auth runtime |
| `locked_out` | **owner unlock (offline-capable):** command `auth.clearPinLockout` runs on this device | `unlocked` | `consecutiveFailures := 0`; PIN kept; emits `auth.pin_lockout_cleared` | user holding `auth.pin_unlock` (02-permissions §11) |
| `locked_out` / any | **owner PIN reset (offline-capable):** a verifier with a newer `asOf` applies for this user (api/02-auth §6.6, permission `auth.user_reset_pin`; resetting a main_owner-role-holder's PIN additionally requires the actor to hold main_owner — api/02-auth §6.6) | `unlocked` | counter := 0; `notBefore` cleared — an auth-runtime side effect (appliers stay pure; the runtime, not the applier, touches `pin_attempt_state`). Audited by the `auth.pin_reset` op itself | resetting owner |

**Recovery from `locked_out` is offline-only — both paths above work offline** (a days-offline store must not brick a cashier, D1/NFR-1001). **There is no online self-recovery:** PIN-only users hold no server credential, so "online full re-auth" is not implementable for them; the PIN never transits the network (api/02-auth §3).

- **Clock rollback does not shrink a window:** `notBefore` is stored as ms epoch; if `now < notBefore` the stored value stands and is never recomputed downward (SEC-AUTH-04). The hard-lock threshold is counter-based and clock-independent.
- Per-attempt failure records stay in local `pin_attempt_state`/diagnostics tables; the **op log carries the lockout events** (`auth.pin_locked_out` with the failure count, `auth.pin_lockout_cleared`) — the owner-visible, tenant-synced brute-force evidence (FR-1045 spirit).

**Invalid:** any other pair ⇒ `INVALID_TRANSITION`.

**Enforced:** client only (offline auth is the point — FR-1010/FR-1011). Server-side rate limiting of control-plane auth endpoints is owned by api/02-auth §9.

## 10. Sync loop

In-memory, one instance per app process, single-flight (api/01-sync §6). Persisted guards on `SyncState` (fields owned by 01-domain-model §5.2; mirrored in 10-db §9.3): `pushHalted` (bool — set by `CHAIN_BROKEN`, §3) and `syncDisabled` + `syncDisabledReason` (set by `DEVICE_REVOKED`), plus `lastSuccessfulSyncAt`. `pendingOperationCount` / `pendingMediaCount` are **derived queries, never stored** (01 §5.2; formula owned by 06-media-pipeline) — the loop recomputes them. `failureCount` is in-memory.

**Birth:** `idle` at app start.

| From | Event / trigger | To | Side effects | Triggered by |
| ---- | --------------- | -- | ------------ | ------------ |
| `idle` | any trigger of api/01-sync §5 — guard: `!syncDisabled` | `pushing` | if `pushHalted`: push phase is skipped, proceed straight to `pulling` | sync engine; user (manual) |
| `pushing` | push drained (all `local` ops pushed · nothing to push · `pushHalted` set mid-push by `CHAIN_BROKEN`) | `pulling` | per-op `syncStatus` transitions per §3 | sync engine |
| `pushing` | transport/server failure (network error, timeout, 5xx) | `backoff` | `failureCount += 1`; timer per schedule below | sync engine |
| `pulling` | drain complete (`hasMore = false`) | `idle` | `lastSuccessfulSyncAt := now`; `failureCount := 0`; staleness recompute (§8); recompute derived counts (01 §5.2); if the rerun flag is set, immediately re-enter `pushing` | sync engine |
| `pulling` | transport/server failure | `backoff` | `failureCount += 1`; partial progress kept — cursor already persisted per applied batch (api/01-sync §4) | sync engine |
| `backoff` | timer elapsed | `pushing` | | timer |
| `backoff` | manual trigger (pull-to-refresh) **or** connectivity regained | `pushing` | timer cancelled | user / NetInfo |
| `pushing` / `pulling` | any trigger arrives | (no transition) | rerun flag set — triggers coalesce, single-flight | any trigger |
| any | `401 DEVICE_REVOKED` | `idle` | `syncDisabled := true`, `syncDisabledReason := 'device_revoked'`; surfaced; no further automatic cycles until re-enrollment (§5) | server response |

- **Backoff schedule (owned by api/01-sync §6, restated):** 5 s → 15 s → 60 s → 5 min cap, reset on success.
- An op-level `rejected` result is **not** a loop failure — the loop marks the op (§3), surfaces it, and proceeds. Only transport/server errors enter `backoff`.
- Automatic triggers arriving during `backoff` are absorbed (they neither shorten nor reset the timer); only the two early-exit events above cancel it.
- The loop never throws to the UI (api/01-sync §6); failures speak through `SyncState` and staleness (§8).

**Invalid:** any other pair ⇒ `INVALID_TRANSITION` (dev: crash; prod: log, machine unchanged).

**Enforced:** client only.

## 11. Note.status (reference module `notes`)

The v0 reference module's single entity machine (04-module-contract §8).

**Realization:** the machine is realized as the `archived` boolean column on the entity (01-domain-model §9; both notes DDLs, 10-db) — `active` ⇔ `archived = false`, `archived` ⇔ `archived = true`. The values are derived states, not a stored text column; the §1 parity test maps them to the flag.

**Birth:** `active`, when `notes.note_created` applies.

| From | Event / trigger | To | Side effects | Triggered by |
| ---- | --------------- | -- | ------------ | ------------ |
| `active` | `notes.note_body_edited` op applied | `active` (self) | body updated | user with `notes.edit` via `editNoteBody` |
| `active` | `notes.note_archived` op applied | `archived` | — | user with `notes.archive` via `archiveNote` |

**Terminal:** `archived`. No unarchive in v0 (04 §8 scope: create / edit body / archive).

**Command-time preconditions:** `editNoteBody` and `archiveNote` require projected `status = active`; else `INVALID_TRANSITION`.

**Projection-time total rules (offline merge):**

- `notes.note_body_edited` sorting after `notes.note_archived` in canonical order: the body updates, `status` stays `archived` — the edit happened and the log is truth (05 §1). The server-side Rule-2 check (N2 below) surfaces the sequence as a Conflict; the fold itself stays total.
- Duplicate `notes.note_archived`: no-op, not a conflict.

**Conflict rules registered by `notes`** (rule mechanics and classification owned by 01-domain-model §8; quoted here so v0 exercises **every** Conflict transition — exit criterion D4):

| Rule | Sequence | Classification |
| ---- | -------- | -------------- |
| N1 | concurrent body edits of the same note from different devices — `notes.note_body_edited` declares conflict `{key: 'note.body', severity: 'minor'}` (01 §8) | minor → `auto_resolved` (canonical-order last-writer-wins on body; both ops retained in the log; Conflict rows recorded, visible in audit) |
| N2 | body edit merged after archive (editor acted without knowing) — caught by the registered Rule-2 invariant check `notes:edit_after_archive` (server-side, at acceptance: a body-edit op whose entity is archived at fold time; 01 §8.2) | significant → `surfaced` → owner acknowledges |

**Enforced:** command preconditions client-side (v0 commands are client-only, 04 §2); appliers run on both runtimes and are total.

## 12. Typed errors owned by this doc

All are `DomainError` codes registered in 04-module-contract §5.2's code registry (this doc defines when its machines throw them), mapped to user copy via the label catalog (07-i18n). Server push-rejection codes (`BAD_SIGNATURE`, `CHAIN_BROKEN`, `CHAIN_HALTED`, …) are a **separate namespace owned by 05 §8** — never mix the two.

| Code | Thrown when | `details` |
| ---- | ----------- | --------- |
| `INVALID_TRANSITION` | any command precondition or runtime transition violates a table in this doc | `{machine, from, event, entityId?}` |
| `LAST_ADMIN_PROTECTED` | the server refuses to deactivate the last active user holding tenant administration (§6 guard — server endpoint check only, `409` from api/02-auth §5.4; surfaced client-side under this code) | `{userId}` |
| `PIN_RATE_LIMITED` | PIN attempt during a `delayed` window (§9) | `{retryAt}` (ms epoch) |
| `PIN_LOCKED` | PIN attempt while `locked_out` (§9) | `{userId, deviceId}` |

## 13. Not machines, and deferred enums

| Thing | Ruling |
| ----- | ------ |
| `Tenant.status` (`active`/`suspended`, PRD-011 §5) | **Deferred.** v0 has no suspension path; tenants are implicitly active and the column does not exist yet. SaaS-era machine — roadmap.md. Adding it later is a migration + an edit to this doc first. |
| Idle lock (PRD-011 FR-1015, §6.2) | UI/session condition (switcher shown, in-progress work preserved), not a persisted enum. Owned by api/02-auth + design system. |
| `SyncState.pushHalted`, `SyncState.syncDisabled` (+ `syncDisabledReason`) | Persisted boolean guards (fields owned by 01-domain-model §5.2), documented in §10 — not enums. |
| Server-side media chunk-session state | Owned by api/03-media.md; not a client enum. |
| v1+ machines (POS shift, repair status, delivery, …) | Do not exist. Registered in this doc when their module is specced — a module spec introducing a status enum without a row in §2 is a spec bug. |
