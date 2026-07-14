# API 01 — Sync Protocol

> **Owns:** push/pull endpoints, batching, cursors, resumability, scope rules, sync triggers, client sync-loop behavior. Envelope/validation semantics live in `05-operation-log.md`; transport conventions (envelope, errors, auth header) in `api/00-conventions.md`.
> **Change control:** change this doc first, then code. Wire-format changes are versioned via the `/v1/` path prefix.

## 1. Principles

- Ops are written **locally first, always**; sync is background, never blocks the user (FR-1107, FR-1125).
- Push and pull are independent; either may succeed while the other fails.
- Resumable: interruption never restarts a sync from zero (FR-1122). Incremental: a week offline pulls a week (FR-1123).
- Efficient on bad 3G: batched, gzip-compressed request/response bodies, no chattiness (FR-1127).

## 2. Transport auth

All sync calls carry the **device token** (issued at enrollment, `api/02-auth.md`) as `Authorization: Bearer <token>`. The token authenticates the *device*; per-op attribution comes from the signed op itself. Revoked device ⇒ `401` + all pushed ops rejected `DEVICE_REVOKED`.

Rate limits (this doc owns the sync numbers, per api/00 §11's delegation): 120 requests/min per device across `/v1/sync/*`; excess ⇒ `429 RATE_LIMITED`. Generous by design — the client loop is single-flight and coalesced (§6); the limit exists to cap runaway clients, not to shape normal traffic.

## 3. Push

```
POST /v1/sync/push
{ "deviceId": "...", "ops": [SignedOperation, ...] }   // ascending seq, ≤ 500 ops and ≤ 1 MiB gzipped per batch
```

Server processes **in order**, per op: dedupe → signature → chain continuity → scope → schema (order + codes in 05 §8–9). Response:

```
{ "results": [ { "id": "...", "status": "accepted" | "duplicate" | "rejected",
                 "serverSeq"?: number, "code"?: string, "reason"?: string } ],
  "serverTime": <ms epoch> }
```

- `accepted` and `duplicate` are both terminal-success: client marks `synced`.
- First `CHAIN_BROKEN` in a batch: remaining ops in the batch are returned `rejected`/`CHAIN_HALTED` (they cannot be validated past a broken link). Client halts push for this device and surfaces.
- `CHAIN_GAP` (client sent seq N+2 when server has N): client re-pushes from N+1. Normal after a partially-acknowledged batch — not an error.
- Client marks each op per its individual result; a network failure mid-request means client retries the same batch (idempotent — already-accepted ops return `duplicate`).

## 4. Pull

```
POST /v1/sync/pull
{ "cursor": <serverSeq, 0 for never-synced>, "limit": 500, "devicesDirectoryVersion": <int, 0 if none> }
→ { "ops": [SignedOperation...], "nextCursor": number, "hasMore": boolean, "serverTime": <ms>,
    "devices"?: DeviceInfo[], "devicesDirectoryVersion"?: number }
```

- Cursor = last applied `serverSeq`, persisted client-side **after** the batch is applied atomically (ops inserted + projections updated in one local transaction). Crash mid-batch ⇒ re-pull same batch ⇒ idempotent no-op.
- Client loops while `hasMore`.

### 4.1 Devices sidecar

The server keeps a per-tenant integer `devicesDirectoryVersion`, bumped on any device enrollment/revocation. When the client's echoed version differs, the response carries `devices`: a **full snapshot** of the device's pull scope — `DeviceInfo { id, storeId, kind: 'member' | 'system', signingKeyPublic, status, revokedAt }`. Revoked devices remain listed (their historical signatures must stay verifiable). The client replaces its `device_registry` table atomically and stores the new version in `SyncState`. Device state is learned from this sidecar (directory truth), never from ops.

### 4.2 Client-side verification of pulled ops

Every pulled op is verified (signature against `device_registry` pubkeys): trust, but verify — a compromised server must not be able to inject unsigned history silently. On failure:

- **Unknown pubkey** (signer not in `device_registry`): re-pull once with `devicesDirectoryVersion: 0` to force a fresh sidecar. Still unknown ⇒ quarantine.
- **Verified-bad signature** ⇒ quarantine.
- **Quarantine** = insert into the client `quarantined_ops` table, do NOT apply to projections, **advance the cursor** (one bad op must not brick sync), surface loudly (banner, label `sync.quarantine.*`). Quarantined ops are re-verified whenever a new devices sidecar arrives; on success they apply normally (the projection engine's out-of-order path handles the late arrival).

### 4.3 Pull scope (v0 rule)

A device receives ops where `tenantId = device.tenantId` AND (`storeId = device.storeId` OR `storeId IS NULL`).

Cross-store pull for multi-store owners / main owner dashboards is a **v1 concern** (OQ-1103, roadmap) — the cursor design must not preclude per-scope cursors later; therefore cursor is opaque to the client (an integer today, but clients must not do arithmetic on it).

## 5. Sync triggers (OQ-1104 resolved)

All of: (a) connectivity regained (NetInfo listener), (b) debounced 3 s after any local append, (c) periodic every 60 s while online and app foregrounded, (d) background task best-effort (Expo background task — cadence is OS-controlled; treat as bonus, not guarantee), (e) manual pull-to-refresh.

## 6. Client sync loop (normative)

```
loop:
  push all syncStatus=local ops in seq order (batched)   // skipped while SyncState.pushHalted
  pull until hasMore=false                                // applies devices sidecar when present
  conditional GET /v1/devices/me/bundle                   // once per loop; 304 steady-state (api/02-auth §5)
  set SyncState.lastSuccessfulSyncAt / lastServerTime; recompute derived pending counts
```

- Single-flight: at most one sync loop running; triggers coalesce.
- Backoff on failure: 5 s → 15 s → 60 s → 5 min cap, reset on success. Op-level rejections are NOT loop failures (03-state-machines §10).
- Never throws to UI; failures update `SyncState` which drives staleness indicators (03-state-machines §8).
- `pendingOperationCount` / `pendingMediaCount` are derived queries, never stored (01-domain-model §5.2).

## 7. Staleness (consumer contract)

`SyncState.lastSuccessfulSyncAt` drives escalating indicators (FR-1134); the level names and numeric thresholds are owned by **03-state-machines §8** — no other doc restates the numbers. Cross-store views (v1+) must display the **oldest contributing store's** sync time, never the local device's (FR-1135) — the pull response's `serverTime` is stored to compute honest server-relative staleness even when the device clock drifts.

## 8. What sync is NOT

- Not media transfer — media has its own resumable channel (`api/03-media.md`); ops referencing media sync independently (FR-1138).
- Not realtime — the realtime channel (api/00-conventions §realtime) is an optimization that *triggers* a pull; correctness never depends on it (FR-1146).
- Not conflict resolution — business conflicts are detected by projections/conflict rules after ops merge (01-domain-model §conflicts), never by sync refusing an op.
