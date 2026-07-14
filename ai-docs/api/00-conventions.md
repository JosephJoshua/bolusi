# API 00 — Conventions

> **Owns:** everything common to all API endpoints — base path, transport, auth header handling, request/response envelopes, HTTP error codes, gzip request handling and size caps, idempotency conventions, pagination shape, versioning, server-time header, realtime channel conventions, rate limiting, Hono middleware order, and RPC type-sharing. Endpoint-specific bodies live in their owning docs: sync in `api/01-sync.md`, identity (login, control sessions, enrollment, devices, users, tenant settings) in `api/02-auth.md`, media in `api/03-media.md`, push notifications in `api/04-push.md`. The op envelope and rejection codes live in `05-operation-log.md` — never redefined here.
> **Change control:** change this doc first, then the code.

## 1. Endpoint map (v0)

| Route | Method | Auth | Owning doc |
| ----- | ------ | ---- | ---------- |
| `/v1/auth/login` | POST | **exempt** — control credential (loginIdentifier + password) | api/02-auth §4 |
| `/v1/auth/password` | POST | control-session bearer (§3) | api/02-auth |
| `/v1/devices/enroll` | POST | control-session bearer + `Idempotency-Key` (§8.2) | api/02-auth §4 |
| `/v1/devices` | GET | bearer (§3) | api/02-auth §7 |
| `/v1/devices/:id/revoke` | POST | bearer (§3) | api/02-auth §7 |
| `/v1/devices/me/bundle` | GET (conditional) | device bearer | api/02-auth §5 |
| `/v1/devices/me` | GET | device bearer — the revocation confirm-then-wipe check | api/02-auth §7.3 |
| `/v1/users`, `/v1/users/:id`, `/v1/users/:id/deactivate`, `/v1/users/:id/reactivate`, `/v1/users/:id/pin-verifier` | POST / PATCH | bearer (§3) | api/02-auth §5 |
| `/v1/tenant/settings` | PATCH | bearer (§3) | api/02-auth |
| `/v1/sync/push` | POST | device bearer | api/01-sync §3 |
| `/v1/sync/pull` | POST | device bearer | api/01-sync §4 |
| `/v1/media/:id/init`, `/v1/media/:id/complete` | POST | device bearer | api/03-media §3 |
| `/v1/media/:id/chunks/:index` | **PUT** | device bearer | api/03-media §3.2 |
| `/v1/media/:id/status` | GET | device bearer | api/03-media §3.3 |
| `/v1/media/:id` | GET | device bearer | api/03-media §3.5 |
| `/v1/push/tokens` | POST | device bearer — no client-facing DELETE in v0; deletion is server-internal on revocation | api/04-push §2 |
| `/v1/realtime` | GET (WS upgrade) | device bearer | this doc §12 |
| `/v1/realtime/sse` | GET (SSE stream) | device bearer | this doc §12 |

`POST /v1/auth/login` is the **only** bearer-exempt route — it is where control-session tokens come from (§3). Every other route — including realtime — returns `401` without a valid bearer token. Which token kind (device vs control-session) each identity route accepts is owned by api/02-auth.

## 2. Transport & shape

- HTTPS only (TLS ≥ 1.2). Plain HTTP shall not be served, ever — not even redirects in production.
- Base path `/v1` on every route (§4 versioning).
- Style: **POST-JSON RPC**. All data operations are `POST` with a JSON body — including reads like sync pull (matches api/01-sync). `GET` exists only for the realtime upgrade/stream routes, media status/object fetch (api/03-media), and the identity read surface (`/v1/devices`, `/v1/devices/me`, `/v1/devices/me/bundle` — api/02-auth). Media chunk upload is `PUT` (api/03-media §3.2).
- `Content-Type: application/json; charset=utf-8` on JSON requests and responses.
- No cookies, no sessions, no CSRF tokens. Auth is the bearer header only.
- No CORS middleware in v0 — the only client is the native app. Adding a web client later is an additive change that introduces CORS then, not now.
- Server runtime: Node 22 LTS (kysely 0.29.3 `engines >=22`), hono 4.12.30, @hono/node-server 2.0.8, @hono/zod-validator 0.8.0, zod 4.4.3 — all pinned exactly.

### 2.1 Global schema rules (all endpoint bodies)

| Rule | Detail |
| ---- | ------ |
| Ids | UUIDv7 strings |
| Timestamps | integer ms epoch — never ISO strings, never seconds |
| Money | integer IDR — no floats anywhere in any schema (05-operation-log §3; lint + Zod enforced) |
| Zod schemas | `.strict()` — unknown keys in **requests** are rejected (422) |
| Response tolerance | clients must **ignore** unknown fields in responses (forward compatibility, §4) |

## 3. Authentication

- Header: `Authorization: Bearer <token>`. The bearer slot carries exactly one of two token kinds, distinguished by prefix; issuance, format, lifetime, and hashing-at-rest for both are owned by api/02-auth:

| Prefix | Kind | Issued by | Authenticates |
| ------ | ---- | --------- | ------------- |
| `bdt_` | device token | enrollment (api/02-auth §4) | the **device**; per-op human attribution comes from the signed op itself (api/01-sync §2) |
| `bcs_` | control-session token | `POST /v1/auth/login` (api/02-auth §4) | a **user** holding the control credential (loginIdentifier + password), for the identity surface |

- Which routes accept which kind is owned by api/02-auth; sync, media, push, and realtime routes accept device tokens only.
- Implementation: `bearerAuth({ verifyToken })` from `hono/bearer-auth`. `verifyToken(token, c)` shall: hash the presented token, look up its record by token hash (constant-time comparison), and on success set request context — for device tokens, require `device.status = 'active'` (03-state-machines) and `c.set('device', { deviceId, tenantId, storeId })`; for control-session tokens, require the session unexpired and `c.set('controlSession', { userId, tenantId })`.
- `X-Acting-User: <userId>` (request header): on device-token requests to identity endpoints, names the acting human behind the shared device. It is attribution input, never authorization by itself — the trust model (validation against the device's directory, permission evaluation) is owned by api/02-auth.
- Failures (all `401`, envelope per §6): missing/unparseable header → `AUTH_TOKEN_MISSING`; unknown or expired token (either kind) → `AUTH_TOKEN_INVALID`; token maps to a revoked device → `DEVICE_REVOKED` (same code string as the op rejection code, 05-operation-log §8 — one vocabulary). On `DEVICE_REVOKED` the client halts sync, surfaces the state, and requires re-enrollment (api/02-auth).
- Tokens never appear in URLs, query strings, or logs — header only, on WS/SSE upgrade requests too (§12).

### 3.1 Tenant context (every authenticated request)

- `tenantId` is derived **exclusively** from the bearer token's context (device or control session, §3) — never read from a request body, path, or header. Any body field claiming a tenant is validated against the token's tenant and rejected on mismatch (op-level: `SCOPE_VIOLATION`, 05-operation-log §9).
- Every handler that touches tenant data opens a Postgres transaction and executes `select set_config('app.tenant_id', $1, true)` as its first statement (transaction-local; session-level `SET` on pooled connections is forbidden — it leaks tenant context). RLS policies `USING (tenant_id = current_setting('app.tenant_id')::uuid)` are the enforcement backstop.
- Application code reaches the DB only through the `forTenant(tenantId)` wrapper factory — the only exported way to query tenant tables. Both layers (wrapper + RLS) are mandatory (decision Q2).

## 4. Versioning

- The path prefix `/v1` is the API version. There is no version header and no per-endpoint version.
- **Additive** changes ship inside `/v1` without ceremony: new endpoints, new optional request fields, new response fields, new WS message types, new error codes.
- **Breaking** changes (removing/renaming fields, changing a field's type or semantics, changing status-code behavior) require a parallel `/v2` — `/v1` keeps working until every enrolled device is confirmed migrated. Never mutate `/v1` semantics in place.
- Client obligations that make additive evolution safe: ignore unknown response fields, ignore unknown WS/SSE message types, ignore unknown error codes (treat as non-retryable and surface generically).

## 5. Request conventions

### 5.1 Headers

| Header | Direction | Semantics |
| ------ | --------- | --------- |
| `Authorization` | req | §3. Required everywhere except `/v1/auth/login`. |
| `X-Acting-User` | req | Acting-user attribution on device-token identity requests (§3; trust model owned by api/02-auth). |
| `Content-Encoding: gzip` | req | Body is gzip-compressed (§5.2). |
| `Idempotency-Key` | req | Required on non-sync mutating endpoints (§8.2). |
| `X-Request-Id` | resp | UUIDv7 per request (`hono/request-id`); echoed in 500 details. Include it in every bug report. |
| `X-Server-Time` | resp | §9. On **every** response, including errors. |
| `X-Idempotent-Replay: true` | resp | Response was replayed from the idempotency store (§8.2). |
| `Retry-After` | resp | Seconds; mandatory on every `429` (§11). |

### 5.2 Gzip request bodies

- Clients SHOULD send `Content-Encoding: gzip` on any JSON body larger than 4 KiB serialized (sync push batches in practice); the server accepts both gzip and identity on all JSON routes.
- Hono has **no** built-in request decompression (`hono/compress` is response-only). A custom middleware handles it: when `Content-Encoding: gzip`, pipe `c.req.raw.body` through `new DecompressionStream('gzip')`, **counting decompressed bytes and aborting at the cap** (gzip-bomb defense — `bodyLimit` sees only wire bytes and cannot defend alone), then present the decompressed stream downstream and strip the header. This middleware is a security surface: it ships adversarial tests (gzip bomb, truncated stream, garbage bytes labeled gzip, double-encoding) BEFORE review, per CLAUDE.md §2.5.
- Encoding handling: absent or `identity` → pass-through; `gzip` → decompress; anything else (`deflate`, `br`, `gzip, gzip`, …) → `415 UNSUPPORTED_ENCODING`. Malformed or truncated gzip → `400 MALFORMED_REQUEST`.

### 5.3 Body-size caps

| Route class | Wire cap (`bodyLimit`, compressed or identity bytes) | Decompressed cap (middleware) |
| ----------- | ---------------------------------------------------- | ----------------------------- |
| Sync push (`/v1/sync/push`) | **1 MiB** | **10 MiB** |
| Default JSON (pull, identity, push tokens, everything else) | 256 KiB | 1 MiB |
| Media chunk upload | per-route, owned by api/03-media | gzip not accepted → `415` (media chunks are already-compressed binary) |

Exceeding the wire cap → `413 BODY_TOO_LARGE`. Exceeding the decompressed cap → `413 DECOMPRESSED_TOO_LARGE`. Client response to either on sync push: split the batch (the ≤ 500-op batch rule in api/01-sync §3 makes this reachable only with pathological payloads — treat as a bug signal too).

## 6. Response envelope

- **Success:** HTTP `200` with a **bare typed JSON body** — no wrapper object, no `{ data: ... }`, no success flag. The endpoint's Zod-typed shape is the body (e.g. api/01-sync push/pull responses).
- **Error:** HTTP 4xx/5xx with exactly:

```jsonc
{
  "error": {
    "code": "RATE_LIMITED",        // §7 registry; UPPER_SNAKE, stable, machine-matched
    "message": "Too many requests", // English, for logs/developers — NEVER shown raw to users
    "details": { }                  // optional, code-specific shape (§7)
  }
}
```

- The error envelope never appears with a 2xx status; a 2xx body never contains `error`.
- `message` is not localized and not user-facing. Clients map `code` to user copy via the label catalog (07-i18n) — hardcoded user-facing strings are forbidden.
- **HTTP errors ≠ op rejections.** A sync push that transports fine returns `200` even when every op in it is rejected — per-op `rejected` statuses and codes (`BAD_SIGNATURE`, `CHAIN_BROKEN`, …) travel inside the 200 body (api/01-sync §3, 05-operation-log §8). HTTP-level errors mean the *request itself* failed (auth, size, shape, rate); no op in it was evaluated.

## 7. HTTP status & error-code registry

| HTTP | `error.code` | When | `details` | Client behavior |
| ---- | ------------ | ---- | --------- | --------------- |
| 400 | `MALFORMED_REQUEST` | Unparseable JSON; malformed/truncated gzip | — | Not retryable; bug — report |
| 401 | `AUTH_TOKEN_MISSING` | No/unparseable `Authorization` header | — | Bug — report |
| 401 | `AUTH_TOKEN_INVALID` | Unknown or expired device token | — | Re-authenticate per api/02-auth |
| 401 | `DEVICE_REVOKED` | Token maps to revoked device | — | Halt sync; surface; re-enroll (03-state-machines) |
| 403 | `PERMISSION_DENIED` | Authenticated but not allowed (e.g. query against a store the user is not assigned to — security-guide §2.2) | — | Surface; not retryable |
| 404 | `NOT_FOUND` | Unknown route or entity | — | Not retryable |
| 409 | `IDEMPOTENCY_CONFLICT` | `Idempotency-Key` reused with a different body (§8.2) | — | Bug — report; never auto-retry with same key |
| 413 | `BODY_TOO_LARGE` | Wire bytes exceed route cap (§5.3) | `{ "limitBytes": n }` | Split batch / shrink chunk |
| 413 | `DECOMPRESSED_TOO_LARGE` | Decompressed bytes exceed cap (§5.3) | `{ "limitBytes": n }` | Split batch |
| 415 | `UNSUPPORTED_ENCODING` | `Content-Encoding` other than gzip/identity; gzip on a binary media route | — | Bug — report |
| 422 | `VALIDATION_FAILED` | Body fails the endpoint's Zod schema; missing required `Idempotency-Key` | `{ "issues": [...] }` (§7.1) | Bug — report (client validates before send) |
| 429 | `RATE_LIMITED` | §11 | `{ "retryAfterSeconds": n }` + `Retry-After` header | Wait, then resume normal backoff |
| 500 | `INTERNAL` | Unhandled server error | `{ "requestId": "..." }` | Retry with the sync backoff schedule (api/01-sync §6) |

Only 429 and 500 are retryable-as-is. 4xx (except 429) means the same request will fail again — clients shall not retry-loop them.

### 7.1 Validation errors (422)

`zValidator`'s **default** failure response is a 400 with a raw Zod error — never ship that. Every `zValidator('json', schema, hook)` uses one shared hook that emits the §6 envelope with status `422` and:

```jsonc
"details": {
  "issues": [ { "path": ["ops", 3, "payload", "title"], "code": "too_small", "message": "..." } ]
}
```

`issues[*]` is mapped from `ZodError.issues` (zod 4.4.3): `path` (array of string|number), `code` (Zod issue code), `message`. Nothing else from the Zod internals leaks (no `input` echo — payloads may contain sensitive data).

## 8. Idempotency

Two disjoint mechanisms; an endpoint uses exactly one.

### 8.1 Sync: op `id` is the key

Push idempotency is the op's `id` (UUIDv7) — replaying an accepted op returns `duplicate` (05-operation-log §5). Pull is read-only and cursor-driven. Sync endpoints therefore take **no** `Idempotency-Key` header; if sent, it is ignored.

### 8.2 Non-sync mutations: `Idempotency-Key` header

Applies to every mutating endpoint that does not carry ops — in v0 the canonical consumer is **device enrollment** (`POST /v1/devices/enroll`, api/02-auth); each owning doc marks the header required on its other non-sync mutations, and future non-sync mutations inherit this convention automatically.

- Client generates a UUIDv7 per logical attempt and **reuses it on every retry** of that attempt. Missing header on a required endpoint → `422 VALIDATION_FAILED`.
- Server stores, keyed by `(endpoint, identity, key)`: SHA-256 of the raw request body + the full response (status + body), retained **24 h**. Identity = the bearer token's record (device or control session, §3).
- Same key + same body hash → replay the stored response verbatim, with `X-Idempotent-Replay: true`. Same key + different body hash → `409 IDEMPOTENCY_CONFLICT`, nothing executed.
- Concurrent duplicate (first request still in flight) → second request waits or returns the stored result once the first commits; the operation shall execute at most once.

## 9. Server time

Every response — success, error, WS upgrade rejection, SSE — carries `X-Server-Time: <integer ms epoch>`, stamped at response generation. Sync response **bodies** additionally carry `serverTime` (owned by api/01-sync §3–4); the body field is authoritative for the sync loop's staleness computation (api/01-sync §7), the header is the general-purpose signal (device-clock drift detection, honest staleness on non-sync calls). Clients never adjust the device clock from it — op `timestamp` remains the device's honest belief (05-operation-log §6).

## 10. Pagination

Convention for every list-shaped endpoint (server API here; module-local queries follow 04-module-contract §6):

- Request: `{ cursor?, limit? }`. `cursor` absent/`0`-equivalent = start. `limit` has a per-endpoint default and hard max (sync: 500, api/01-sync).
- Response: data field(s) + `nextCursor` (+ `hasMore` where the owning doc defines it, e.g. sync pull).
- Cursors are **opaque**: the client stores and echoes them verbatim, never constructs, parses, or does arithmetic on them. Wire encoding (integer `serverSeq` today for sync pull, strings for module queries) is each owning doc's business and may change without notice — that opacity is what keeps per-scope cursors (api/01-sync §4.1, OQ-1103) an additive v1 change.
- No offset pagination anywhere, ever.

## 11. Rate limiting

- Posture: per **device token** on authenticated routes, per **source IP** on the bearer-exempt `/v1/auth/login`. Algorithm: token bucket, burst = the per-minute cap, continuous refill.
- Every `429` carries `Retry-After: <seconds>` and the §7 envelope with `RATE_LIMITED` — the **only** 429 code in the registry; surface-specific 429 codes do not exist. Clients wait at least that long, then resume the normal sync backoff (api/01-sync §6) — a 429 does not reset backoff to zero.
- **This doc owns only the defaults.** Per-endpoint numeric limits live in the owning endpoint doc:

| Surface | Numeric limits owned by |
| ------- | ----------------------- |
| Sync push/pull | api/01-sync |
| Media endpoints | api/03-media §8 |
| Identity surface (`/v1/auth/*`, `/v1/devices*`, `/v1/users*`, `/v1/tenant/*`) | api/02-auth |
| Push tokens | api/04-push |
| Realtime connect (WS or SSE) | owned here: **10 / min / device** |
| All other authenticated routes (default) | owned here: **120 / min / device** |
| Aggregate per device (default) | owned here: **600 / min** |

v0 implementation: in-memory per-process buckets (single-instance deployment). Horizontal scaling requires a shared store — a roadmap item, not a v0 concern; the middleware interface shall not assume in-memory.

## 12. Realtime channel

Realtime is an **optimization that triggers a pull** — correctness never depends on it (api/01-sync §8). Missed pokes cost only latency.

### 12.1 WebSocket (primary)

- Endpoint: `GET /v1/realtime`, upgraded via `upgradeWebSocket` from **@hono/node-server 2.x** with the `ws` package (`new WebSocketServer({ noServer: true })` passed as `serve({ ..., websocket: { server: wss } })`). The separate `@hono/node-ws` package is deprecated — never reference or install it.
- Auth: `Authorization: Bearer <deviceToken>` header on the upgrade request (React Native's WebSocket supports request headers). Invalid/missing/revoked → plain HTTP `401` (§7) before any upgrade. Tokens never go in the query string.
- The WS route carries **only** `requestId` + `bearerAuth` middleware — no header-mutating middleware (CORS, compress) on this route; `upgradeWebSocket` mutates response headers internally and combining them throws immutable-header errors.
- Frames: JSON text, server→client only in v0, shape `{ "type": string, "payload": object }`. Clients ignore unknown `type`s; the server ignores all client frames in v0.
- v0 message registry:

| `type` | `payload` | Sent when | Client reaction |
| ------ | --------- | --------- | --------------- |
| `sync.poke` | `{}` | Op(s) accepted within this device's pull scope (api/01-sync §4.1) | Trigger the sync loop (single-flight, coalescing — api/01-sync §6) |

- Server coalesces pokes: at most one `sync.poke` per connection per second.
- Keepalive: server sends WS protocol-level ping every 30 s; closes the connection after 2 missed pongs. Message schemas live in the shared schemas package (`@bolusi/schemas`) as Zod schemas — RPC does not type WS frames (§14).

### 12.2 SSE fallback

- Endpoint: `GET /v1/realtime/sse` via `streamSSE` from `hono/streaming`. Same bearer auth header (the client consumes it with streaming `fetch` — RN has no native `EventSource`).
- Events: `event: sync.poke`, `data: {}`, monotonically increasing `id`. Heartbeat comment (`: hb`) every 25 s. Same coalescing and scope rules as WS.

### 12.3 Fallback ladder & polling cadence

1. **WS** is the primary transport. Reconnect on drop with backoff 5 s → 15 s → 60 s → 5 min cap (same schedule as sync).
2. After **3 consecutive** WS connection failures → switch to **SSE** (same backoff).
3. SSE also failing → **polling only**: no extra mechanism — the existing 60 s foreground periodic sync trigger (api/01-sync §5c) *is* the polling fallback. This doc does not alter any sync-trigger cadence.
4. While degraded, retry WS every 5 min; on success, tear down the lower rung. Reset all counters on success.

The realtime connection state never blocks or gates sync — all api/01-sync §5 triggers keep running regardless.

## 13. Middleware order (normative)

Applied top→bottom; the relative order **bearerAuth → bodyLimit → gzip-decompress → zValidator** is load-bearing (auth cheap-fails first; wire-byte cap before decompression work; decompressed cap before parse) and shall not be reordered.

| # | Middleware | Notes |
| - | ---------- | ----- |
| 1 | `requestId` (`hono/request-id`) | `X-Request-Id` |
| 2 | server-time | stamps `X-Server-Time` on every outgoing response |
| 3 | access logging | logs code+path+requestId+deviceId; never tokens or bodies |
| 4 | `compress` (`hono/compress`) | **response**-only gzip; excluded from WS/SSE routes |
| 5 | per-IP rate limit | `/v1/auth/login` only (pre-auth) |
| 6 | `bearerAuth({ verifyToken })` | all routes except `/v1/auth/login` (§3) |
| 7 | per-device rate limit | keyed by device from step 6 |
| 8 | `bodyLimit` | wire-byte cap per §5.3; `onError` → 413 envelope |
| 9 | gzip request decompression (custom) | §5.2, decompressed-byte cap |
| 10 | `zValidator('json', schema, hook422)` | §7.1 shared hook |
| 11 | handler | opens tenant transaction + `set_config` (§3.1) |

WS/SSE routes use only steps 1–3 minus compress, plus 5–7 (no body middleware; step 4 excluded per §12.1).

## 14. TypeScript type-sharing (Hono RPC)

- The server is composed of **sub-routers** per area (`auth`, `devices`, `users`, `tenant`, `sync`, `media`, `push`, `realtime` — the list 08-stack-and-repo §3.2 mirrors), each built with chained route definitions (chaining is what makes inference work), mounted via `.route('/auth', authRoutes)` etc. under `/v1`.
- The server package exports `export type AppType = typeof app`. Types are **precompiled**: the contract surface is emitted as `.d.ts` via tsc project references, and the client imports the type from build output — never deep-imports server source. (RPC inference degrades IDE/typecheck performance as routes grow; sub-routers + precompiled types are the standing mitigation.)
- Client convention: exactly one wrapper module constructs `hc<AppType>(baseUrl, { headers, fetch: customFetch })` where `customFetch` injects the bearer token and gzips request bodies > 4 KiB (§5.2). All client API access goes through this wrapper; direct `fetch` against the API base URL is forbidden (lint-enforced).
- Request/response Zod schemas, the error envelope schema, and realtime message schemas live in the shared schemas package (`@bolusi/schemas`) and are the single definition used by `zValidator` server-side and by client-side pre-send validation. `hc`'s `$ws()` gives a typed socket handle, but frame payloads are **not** RPC-typed — validate them with the shared Zod schemas (§12.1).
- zod is pinned 4.4.3 workspace-wide; a duplicate zod v3 in the lockfile breaks `@hono/zod-validator` 0.8.0 types — the lockfile check for duplicate zod majors runs in CI.
