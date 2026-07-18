# TASK 20 — realtime (WS + SSE server, client poke→pull, polling fallback)
**Status:** in-progress
**Depends on:** 12, 15

## Goal
Deliver the realtime channel of api/00 §12 end to end. Server side (`@bolusi/server`): the `GET /v1/realtime` WS route via `upgradeWebSocket` from `@hono/node-server` 2.0.8 with `ws` (`new WebSocketServer({ noServer: true })` passed as `serve({ ..., websocket })` — never `@hono/node-ws`), the `GET /v1/realtime/sse` fallback via `streamSSE`, device-token auth at upgrade (task 12's `verifyToken`, plain `401` before any socket), and a connection hub that fans out the frozen `sync.poke` message to connections matching pull scope (api/01 §4.1/§4.3: same tenant AND (same store OR storeId null)), with per-connection 1/s coalescing, 30 s ping / 2-missed-pong keepalive, max 1 WS per device token, and `closeForDevice(deviceId)` for revocation. The hub exposes `pokeAccepted({tenantId, storeId})` as the contract the sync push handler (task 16) calls after ops commit — whichever of 16/20 lands second makes that one-line wiring commit. Client side (`@bolusi/core`, platform-free with injected socket/SSE-reader factories and ClockPort): poke → trigger the task-15 sync loop, pull-on-(re)connect backfill, and the §12.3 fallback ladder (WS backoff 5 s→15 s→60 s→5 min; 3 WS failures → SSE; SSE failing → polling-only where the existing 60 s periodic trigger IS the fallback — no new cadence; WS retry every 5 min while degraded). Correctness never depends on the channel (FR-1146). Out of scope: real push-handler bodies (16), push notifications (21), RN socket/fetch adapters (24), revoke-endpoint wiring to `closeForDevice` (13).

## Docs to read
- `api/00-conventions.md` — §12 (12.1–12.3, all normative numbers live here), §13 last line (reduced middleware chain on WS/SSE routes), §11 (realtime-connect 10/min/device row), §14 (WS frames are NOT RPC-typed — validate with `@bolusi/schemas`), §1 (the two realtime route rows).
- `api/01-sync.md` — §4.1/§4.3 (pull scope = fan-out scope), §5 (triggers; c is the polling fallback), §6 (single-flight loop the poke triggers), §8 (what sync is NOT — FR-1146).
- `08-stack-and-repo.md` — §2.4 (`@hono/node-server` 2.0.8 + `ws` rows, header-mutation caveat), §2.6 (`@hono/node-ws` forbidden), §3.2 (`@bolusi/server`, `@bolusi/core` rows), §3.3 (no `ws` import in core; injected ports).
- `security-guide.md` — §9 (checklist + SEC-RT table), §2.1 (test-title/ID conventions).
- `testing-guide.md` — §1 (T-1..T-5), §2.1 (test layers; L3/L4 in-process style).

## Skills
- `superpowers:test-driven-development` — always.
- `superpowers:verification-before-completion` — run the suites, read the output, before claiming done.
- `context7-mcp` — verify `@hono/node-server` 2.0.8 `upgradeWebSocket`/`serve({ websocket })`, `ws` `noServer` handshake, and `streamSSE` APIs against current docs before use.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched
- `apps/server/src/routes/realtime.ts` — replace task-12 stub: WS upgrade route + SSE route, chained (AppType intact), reduced middleware chain only.
- `apps/server/src/realtime/hub.ts` (+ `types.ts` as needed) — connection registry, `pokeAccepted` fan-out with scope routing, coalescing, keepalive (intervals injectable for tests), single-connection-per-device enforcement, `closeForDevice`.
- `apps/server/src/index.ts` (serve entry) — `WebSocketServer({ noServer: true })` wired via `serve({ ..., websocket })`.
- `apps/server/package.json` — add `ws` 8.x + `@types/ws` (bootstrap-pin per 08 §2.4).
- `packages/core/src/realtime/` — realtime controller: poke handling, backfill-pull on connect, fallback-ladder state machine; ports for socket/SSE-reader factories. **Contended package (`@bolusi/core`, CLAUDE.md §4) — serialize; land before dependents.**
- `packages/schemas` — **consume only** (`sync.poke` WS-message schema from task 02). Gap ⇒ stop and serialize; never edit as a side effect.
- `tooling/eslint` — forbidden-import rule for `@hono/node-ws` (repo-wide) and `ws` importable only under `apps/server`, if task 01's config doesn't already enforce both.
- Tests under `apps/server/` and `packages/core/`.

## Acceptance
- **Observable done-condition:** `pnpm --filter @bolusi/server test` and `pnpm --filter @bolusi/core test` green in Node CI; at least one server test exercises a REAL WS upgrade (`serve()` on an ephemeral port + `ws` client — `app.fetch` cannot drive the upgrade path); SSE tests may run in-process. `tsc -b` green repo-wide.
- **Server behavior tests:**
  - Upgrade with valid device bearer header → open socket; frames received are JSON text parsing against the `@bolusi/schemas` message schema.
  - Fan-out routing table (api/01 §4.1/§4.3): `pokeAccepted({tenantA, store1})` → poked: A/store1 devices; not poked: A/store2, tenant B; `pokeAccepted({tenantA, storeId: null})` → all tenant-A devices, zero tenant-B — asserted on both WS and SSE legs.
  - Coalescing: ≥3 `pokeAccepted` within 1 s → exactly one `sync.poke` frame per connection (injected clock).
  - Keepalive: ping every 30 s; 2 missed pongs → server closes (injectable intervals). SSE: `: hb` comment every 25 s; `event: sync.poke` with monotonically increasing `id`.
  - Single connection: second concurrent WS upgrade for the same device token → at most one live connection remains (assert the invariant).
  - Reduced middleware chain preserved on both routes (task 12's assertion stays green; no compress/body middleware — probe or composition assertion), and realtime-connect rate limit is the §11 10/min/device class → 11th connect in a minute `429` envelope.
  - Idempotency/replay: repeated identical `pokeAccepted` calls and repeated client reconnects leave no hub state leaks (registry size returns to baseline after disconnect; asserted).
- **Client (`@bolusi/core`) behavior tests** (fake factories + FakeClock; T-1..T-3 apply):
  - `sync.poke` frame → sync-loop trigger invoked; rapid pokes coalesce into the single-flight loop (api/01 §6), never a parallel loop.
  - Unknown `type`, malformed JSON, unexpected binary frame → ignored, counted, no throw.
  - Connect and reconnect both fire one backfill pull trigger (missed pokes cost latency only).
  - Fallback ladder: WS drop → retries at 5 s/15 s/60 s/300 s cap; exactly 3 consecutive WS failures → SSE with same backoff; SSE failing → polling-only with **no new timer created** (assert the 60 s periodic trigger from task 15 is untouched and no realtime-owned cadence exists); degraded → WS retry every 5 min; WS success → lower rung torn down, all counters reset.
  - FR-1146 equivalence: with the controller in `failed` state (both transports down), all api/01 §5 triggers still fire and the sync loop completes against a fake TransportPort; resulting `SyncState` is identical to a run with realtime healthy given the same op set. Realtime state never blocks or gates sync (assert no code path from controller state into loop gating).
- **Named SEC tests (security-guide §9.2), titles embedding the ID verbatim:**

**SEC ids owned by THIS task:** SEC-RT-01..05

  - `SEC-RT-01` — WS upgrade and SSE request with missing/invalid/revoked token → plain HTTP `401` (§7 envelope where a body exists), no socket/stream established; token never accepted via query string (a query-string token is ignored → `401`).
  - `SEC-RT-02` — open WS as device D; drive the revocation path (verifyToken now returns revoked + `hub.closeForDevice(D)`) → socket closed by server ≤ 5 s; reconnect → `401`. (Wiring from the real `/v1/devices/:id/revoke` handler is task 13; the hook + test live here.)
  - `SEC-RT-03` — WS/SSE legs: schema audit over every server code path that emits realtime messages — payloads validate against the frozen `{ "type": "sync.poke", "payload": {} }` schema; a fixture emission carrying any business value (amount, name, note body, entity data) fails the suite. Push leg → task 21.
  - `SEC-RT-04` — WS/SSE legs: activity in tenant B / other store produces zero pokes to a tenant-A store-1 device (subsumes the routing test above; run as the adversarial variant with mixed concurrent activity). Push leg → task 21.
  - `SEC-RT-05` — oversized, malformed, and unknown-type client→server WS messages → dropped + counted, connection healthy, no server exception; message flood → connection closed per limits. (v0 server ignores all client frames — assert exactly that.)
- **CHAOS scenarios:** no numbered CHAOS-* scenario names this surface (testing-guide §3.6 catalog checked). The brief's dropped-socket case ships here as the FR-1146 equivalence test above plus: server drops all sockets mid-activity, pokes are lost, the periodic trigger alone still converges client state (fake transport digest equality). Harness packaging is task 26.
- **Lint/CI gates:** ESLint rule forbidding `@hono/node-ws` imports green repo-wide (rule test includes a failing fixture); `@hono/node-ws` absent from lockfile (task 01 check stays green); `ws` imported only under `apps/server` (boundary lint — core stays platform-free per 08 §3.3); SEC test titles greppable; deps exact-pinned; pre-commit hooks pass (no `--no-verify`); `_index.md` Status updated.
