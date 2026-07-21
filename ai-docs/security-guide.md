# Security Guide

> **Owns:** the threat model, per-surface security checklists, the REQUIRED named adversarial tests for every security surface, denied-access response semantics, secrets handling, and dependency security posture. Mechanism specs live in their owning docs (op envelope: 05-operation-log; sync wire: api/01-sync; auth flows: api/02-auth; media wire: api/03-media; push categories/payloads: api/04-push; permission semantics: 02-permissions; state machines: 03-state-machines) — this doc owns *what must be proven about them and how*.
> **Change control:** change this doc first, then the code. Per CLAUDE.md §2.5, security is **written, not reviewed in**: the checklist below is worked through *inside* the implementing task, and the named adversarial tests ship **with the surface, before review-wave**. A security-surface task without its named tests is not review-ready.

## 1. Threat model

Per PRD-011 §8: the adversary is mostly an **insider**, not a nation-state.

| In scope | Example | Primary control |
| -------- | ------- | --------------- |
| Insider with legitimate device access | Cashier guessing a colleague's PIN to void under their name | PIN rate limiting, attribution, signed ops |
| Lost / stolen device | Phone with a week of local data and a valid signing key | SQLCipher at rest, SecureStore keys, revocation |
| Tampered sync input | Modified client replaying, forging, or resequencing ops | Signature + hash-chain verification, fail-closed scope checks |
| Curious client (devtools / patched app) | Purchaser extracting cost prices they cannot see in UI | Data gating in query handlers (FR-1029), server never sends unauthorized fields |
| Cross-tenant probing (SaaS future) | Tenant A guessing tenant B's ids | RLS + forTenant wrapper + 404 semantics |
| Compromised server injecting history | — | Client-side signature verification on pull (api/01-sync §4) |

**Out of scope (do not build for, do not claim):** nation-state attackers, hardware attacks on the Android Keystore, defeating a determined GPS spoofer (PRD-009 §3), root-level malware on the device, facial recognition. Where a control is weaker than it sounds (offline PIN auth, SecureStore extractability, revocation of an offline device), this doc says so plainly — overselling a control is itself a defect (PRD-011 §8: "it should not be described as more than it is").

## 2. Process and conventions

### 2.1 How checklists bind to tasks

1. Every task touching a surface below copies that surface's checklist into its task file and checks items off with evidence (file/line or test name).
2. The surface's **named adversarial tests** (`SEC-<AREA>-<NN>`) must exist and pass before the task enters review-wave. Reviewers verify test *content* against this doc, not just presence.
3. Test titles MUST embed the ID verbatim (e.g. `test('SEC-OPLOG-01 forged signature rejected', ...)`) so they are greppable.
4. **SEC-META-01** (ships with the CI setup task): a meta-test parses this doc for `SEC-[A-Z]+-[0-9]+` IDs and fails CI if any ID has no matching test title in the repo. This is how "tests ship with the surface" is enforced mechanically, not by memory. An ID with no shipped title MUST instead have a row in `packages/test-support/src/sec-pending-allowlist.json` naming its owning task file. An ID that is **both** titled and allowlisted fails the gate — the row says "owed", the title says "shipped", and they cannot both be true.
5. **Ownership is declared, never inferred from prose.** A task file claims the IDs it owns on a single marker line:

   ```
   **SEC ids owned by THIS task:** SEC-RT-01..05, SEC-SECRET-01
   **SEC ids owned by THIS task:** none
   ```

   The value is a comma-separated list of IDs and inclusive ranges (`SEC-RT-01..05`), or the literal `none`. **No trailing prose** — anything else is a malformed marker and fails the gate rather than silently declaring nothing. An allowlist row is valid only when the owning task's marker declares that ID, and **exactly one** task file may declare a given ID. Rationale: the predecessor checked ownership with a substring match over the whole task file, so a task naming an ID only to **disclaim** it ("that's task 07's") satisfied the check, while a task claiming a **range** was rejected for containing no literal ID. Prose cannot express ownership; a grammar can.
6. **A title claims the whole ID, so a partial leg must not title it.** SEC-META-01 matches a title *containing* the ID, and reads that as the ID being fully shipped. Where an ID spans surfaces (e.g. a client leg and a server leg), only the task that completes it may embed the ID verbatim; contributing surfaces reference the ID in a **comment**, never a title — comments are stripped before titles are extracted, precisely so prose can never fake coverage.

### 2.2 Denied-access response semantics (global rule table)

Applies to every endpoint and every query. Follows PRD-011 FR-1036: a permission error, **never an empty result**, for scope the caller may not enter.

| Situation | Response | Rationale |
| --------- | -------- | --------- |
| Resource id belonging to another **tenant** | `404 NOT_FOUND` | Existence is never confirmed across a tenant boundary |
| Same tenant, **store** the user is not assigned to | `403 PERMISSION_DENIED` | FR-1036: empty-200 leaks "store exists and is quiet" |
| Action without the required permission | `403 PERMISSION_DENIED`, denial logged (FR-1045) | Fail closed, and patterns of denials are audit-relevant |
| List query whose *scope* is unauthorized | `403`, never a silently-filtered `200 []` | Same as FR-1036 |
| List query, authorized scope, genuinely no rows | `200` with empty page | Legitimate empty |

**Documented exception — id-keyed resource probes (media download).** `GET /v1/media/:id` returns `404 MEDIA_NOT_FOUND` for every out-of-scope id: cross-tenant, same-tenant unassigned store, another device's in-flight upload, and nonexistent are indistinguishable (api/03-media §2). Justification: FR-1036's "permission error, never an empty result" governs *navigational* queries, where the caller addresses a scope and a silently-filtered result would lie about it. A blind fetch by resource id is the opposite shape — any response that distinguishes "exists but denied" from "does not exist" (`403` vs `404`) is an existence oracle over ids the caller was never shown. Media ids reach a client only inside ops it was authorized to pull, so the legitimate case never needs the distinction. This is the **only** v0 exception to the table above; SEC-MEDIA-03 asserts the `404` on every leg.

Client-side query handlers follow the same table with typed `DomainError` codes (04-module-contract §5.2).

## 3. Surface: Operation log integrity

Mechanism: 05-operation-log (envelope §2, JCS hashing §3, per-device chain §4, rejection codes §8, scope validation §9). Anti-fraud requirements: PRD-009 §2.6 (FR-827..831).

### 3.1 Checklist

- [ ] **Server recomputes, never trusts.** On push, the server recomputes `hash = SHA-256(JCS(signedCore))` from the received fields and verifies the Ed25519 signature over the raw 32-byte recomputed hash against the **claimed device's registered public key**. The client-supplied `hash` field is never used for verification, only cross-checked.
- [ ] **Device binding.** The server rejects (`SCOPE_VIOLATION`) any op whose `deviceId` differs from the device authenticated by the bearer token, and any push body `deviceId` that differs from the token's device. One token, one device, one chain.
- [ ] **Chain continuity** verified per 05 §4: `previousHash` must equal the hash of that device's op at `seq − 1`; genesis rule enforced (`seq = 1` ⇒ 64 zeros). Violations → `CHAIN_BROKEN` and the batch remainder is halted (api/01-sync §3).
- [ ] **Chain-break alarm (FR-829).** Every `CHAIN_BROKEN` / `BAD_SIGNATURE` / `SCOPE_VIOLATION` rejection — and every clock-skew flag — is recorded as a row in the server `device_anomalies` table (`deviceId`, `kind ∈ {BAD_SIGNATURE, CHAIN_BROKEN, SCOPE_VIOLATION, CLOCK_SKEW}`, `at`, `detail` — DDL in 10-db-schema) and surfaced as anomaly counts / last-anomaly-at on `GET /v1/devices` (api/02-auth §7.1), feeding the device-management view (PRD-011 §6.5). These are tamper indicators, not routine errors, and the owner — not the potentially hostile device — is who must see them. This is also the stated mitigation for signing-key extractability (§6.2).
- [ ] **Canonicalization is pinned and vector-tested.** `canonicalize@3.0.0` (RFC 8785) is the single JCS implementation in `@bolusi/core`, used by client and server. RFC 8785 test vectors run in CI **on Hermes** (JCS number serialization depends on spec-correct ES number→string; Hermes must be proven, not assumed — research JSON, crypto caveats).
- [ ] **Non-JSON values rejected at the gate.** The signing path rejects `undefined`, `NaN`, `Infinity`, `BigInt`, functions, and non-plain objects in the signed core *before* canonicalization (JCS mangles or throws on these). Zod `.strict()` payload schemas plus an explicit pre-canonicalization guard.
- [ ] **Crypto interop proven.** Client signs with react-native-quick-crypto 1.1.6 (Ed25519, native); server verifies with @noble/curves 2.2.0. CI runs a cross-implementation suite: N random ops signed by each implementation verify under the other (RFC 8032 interop — research JSON).
- [ ] **No UPDATE/DELETE path exists** (05 §1, FR-831), enforced three ways: (a) lint rule — no `UPDATE`/`DELETE` statement targeting an operations table anywhere outside the projection engine's own tables, with a CI fixture proving the rule fires; (b) server DB: the application Postgres role has `UPDATE`/`DELETE` **revoked** on `operations`, plus a `BEFORE UPDATE OR DELETE` trigger raising an exception (belt and braces — survives a future role misconfiguration); (c) client: the DB wrapper exposes `appendOp` only; no generic write API touches the op table.
- [ ] **Clock skew flags, never rejects** (05 §6). The skew computation uses the documented threshold (48h + offline window) and sets `clockSkewFlagged`; no code path rejects on timestamp. Flagged ops additionally record a `device_anomalies` row (`kind: CLOCK_SKEW`) so skew patterns reach the owner via the alarm above.
- [ ] **Rejected ops are kept and surfaced** — `syncStatus = rejected` is terminal, the op is never deleted, `rejectionCode`/`rejectionReason` reach the user (05 §8, 03-state-machines).

### 3.2 Required adversarial tests

| ID | Name | Asserts |
| -- | ---- | ------- |
| SEC-OPLOG-01 | forged signature rejected | Structurally valid op, correct hash, signature produced by a different Ed25519 key → `BAD_SIGNATURE`; op not persisted as accepted; `device_anomalies` row (`kind: BAD_SIGNATURE`) recorded against the device and reflected in `GET /v1/devices` anomaly counts |
| SEC-OPLOG-02 | replayed op is inert | Already-accepted op re-pushed (same `id`) → `duplicate`; server state unchanged; projections not double-applied on either side |
| SEC-OPLOG-03 | resequenced chain rejected | Two ops from one device pushed with swapped `seq`/`previousHash` relationships → `CHAIN_BROKEN`; remainder of batch `CHAIN_HALTED`; skip-ahead (`seq` N+2 after N) → `CHAIN_GAP`, distinguished from tamper |
| SEC-OPLOG-04 | cross-device seq splice rejected | Op legitimately signed by device A, pushed via device B's token / claiming B's chain position → rejected (`BAD_SIGNATURE` against B's key, or `SCOPE_VIOLATION` on device binding); never accepted into B's chain |
| SEC-OPLOG-05 | payload mutation post-hash rejected | Op signed, then one payload byte mutated in transit → server hash recomputation mismatch → `BAD_SIGNATURE`; test also mutates a non-payload core field (`userId`) with same result |
| SEC-OPLOG-06 | JCS vectors pass on Hermes | Full RFC 8785 appendix vectors + property test (random envelopes: client JCS bytes === server JCS bytes) executed in CI on a Hermes runtime, not only Node |
| SEC-OPLOG-07 | no mutation path | At DB level: `UPDATE`/`DELETE` on `operations` as the app role → permission denied AND trigger exception; at CI level: lint fixture containing a forbidden statement fails the build |
| SEC-OPLOG-08 | clock skew flagged not rejected | Op with `timestamp` 30 days before `receivedAt` (beyond threshold) → `accepted`, `clockSkewFlagged = true`, `device_anomalies` row (`kind: CLOCK_SKEW`) recorded; no rejection code path reachable from skew |
| SEC-OPLOG-09 | pull-side verification | Client pulls an op whose signature does not verify against the tenant's known device pubkeys (simulated compromised server) → op quarantined, not applied to projections, surfaced (api/01-sync §4) |

## 4. Surface: Sync endpoint

Mechanism: api/01-sync. Stack facts: hono 4.12.30, @hono/node-server 2.0.8, @hono/zod-validator 0.8.0, zod 4.4.3 (research JSON, hono area).

### 4.1 Checklist

- [ ] **Middleware order is fixed and load-bearing:** `bearerAuth` (hono/bearer-auth with `verifyToken` against hashed device tokens) → `bodyLimit` (**wire** bytes: 1 MiB, matching api/01-sync §3) → custom gzip-decompression middleware (`DecompressionStream('gzip')` on `c.req.raw.body`) **with its own decompressed-size cap of 10 MiB** → `zValidator('json')`. Any reordering re-opens the gzip-bomb hole: `bodyLimit` counts compressed bytes only.
- [ ] **Decompression is streaming and aborting** — the cap is enforced while inflating (count bytes out, abort the stream at the cap), never by inflating fully and measuring.
- [ ] Malformed gzip, truncated stream, or `Content-Encoding: gzip` on a non-gzip body → `400`, no unhandled rejection, no partial state.
- [ ] **Batch limits enforced server-side** regardless of client behavior: ≤ 500 ops per push/pull, ≤ 1 MiB gzipped (api/01-sync §3).
- [ ] **Scope validation fail-closed** per 05 §9 on every op: tenant, store, user membership ("enrolled" means tenant membership, not `active` status — a user deactivated while a device was offline still gets queued legitimate ops accepted), device not revoked. Per-op result, not batch-level (one bad op must not poison honest neighbors, except behind a `CHAIN_BROKEN` halt).
- [ ] **Idempotent by construction:** dedupe on op `id` (05 §5); a fully re-sent acknowledged batch returns all-`duplicate` and changes nothing.
- [ ] **Revoked device:** token → `401`; any ops that arrive anyway → `DEVICE_REVOKED` (05 §8).
- [ ] **Pull scope** exactly per api/01-sync §4.1: `tenantId = device.tenantId AND (storeId = device.storeId OR storeId IS NULL)`. Pull runs inside a `forTenant` transaction (§8) — RLS backstops a scope bug.
- [ ] Rate limiting: per-device request rate cap on push/pull (coarse, e.g. token bucket 60 req/min) — an insider's patched client must not be able to grind the server. `429` on breach; the client backoff loop (api/01-sync §6) already handles it.
- [ ] Errors never echo secrets or other tenants' data; rejection `reason` strings are static English internal messages (07-i18n owns user-facing copy).

### 4.2 Required adversarial tests

| ID | Name | Asserts |
| -- | ---- | ------- |
| SEC-SYNC-01 | unauthenticated sync rejected | Missing / malformed / unknown bearer token on push and pull → `401`; no body processing occurs (validator never runs) |
| SEC-SYNC-02 | revoked device rejected | Token of a `revoked` device → `401`; ops pushed in the same window → `DEVICE_REVOKED`, kept client-side as `rejected` |
| SEC-SYNC-03 | cross-tenant op claim | Op with `tenantId` of another tenant, pushed with a valid device token → that op `SCOPE_VIOLATION`; sibling valid ops in batch unaffected |
| SEC-SYNC-04 | gzip bomb bounded | ~50 KiB wire body inflating past 10 MiB → `413` at the cap; server RSS delta stays bounded (assert stream aborted, not fully inflated) |
| SEC-SYNC-05 | oversized batch rejected | 501 ops → `422 VALIDATION_FAILED` (fails `zPushRequest.max(500)` at the Zod boundary, per `api/00 §7`/§7.1 — **not** 413/400: §7.1 forbids zValidator's raw-400); and separately > 1 MiB gzipped wire → `413` before any op is processed. Both assert zero ops processed. *(Corrected 2026-07-15: this row said `413`/`400` for both legs, contradicting the error registry that owns status codes. Task 16 followed `api/00 §7` and was right; the guide was wrong. See task 16's SEC-SYNC-05 legs.)* |
| SEC-SYNC-06 | malformed JSON after valid gzip | Valid gzip of invalid JSON → `400 MALFORMED_REQUEST` (unparseable body, before Zod); valid gzip of JSON failing the Zod push schema → `422 VALIDATION_FAILED` with the §6 envelope; no crash, no partial apply. *(Corrected 2026-07-15: this row said `400` for the schema-failure leg. `api/00 §7.1` is explicit — zValidator's default raw-400 must never ship; every zValidator hook emits `422`. Task 16 read the registry correctly; the guide was wrong.)* |
| SEC-SYNC-07 | acknowledged-batch replay idempotent | Push batch, receive results, replay identical batch → all `duplicate`; `serverSeq` sequence unchanged; projections unchanged |
| SEC-SYNC-08 | truncated gzip stream | Connection cut mid-body / truncated deflate stream → `400`, no unhandled rejection, connection resources released |
| SEC-SYNC-09 | pull scope leak probe | Seed ops for tenant B and for tenant A's other store; device (tenant A, store 1) pulls to exhaustion → zero tenant-B ops, zero store-2 ops; tenant-null ops present |
| SEC-SYNC-10 | wrong content-encoding | `Content-Encoding: gzip` header on an uncompressed JSON body → `400`, not a hang or a pass-through |

## 5. Surface: Offline auth & PIN

Mechanism: api/02-auth (enrollment + bundle §4–§5; PIN, lockout machine and its schedule §6.5 — that section owns the numbers mirrored below), PRD-011 §2/§3.2/§7. Stack facts: argon2id via react-native-quick-crypto 1.1.6 native `argon2` — never pure-JS KDF on device (research JSON, crypto area).

### 5.1 What the PIN is — and is not

The PIN authenticates a **user to the switcher on an already-enrolled device** for attribution. It is not the data-at-rest control (that is SQLCipher, §6.4), not a server credential (that is the device token), and not strong. State this in code comments and owner-facing docs exactly as PRD-011 §8 does.

### 5.2 Verifier bundle — residual risk, stated honestly

Offline PIN verification (FR-1010) requires per-user verifiers **on the device**. They arrive exclusively via the control plane — the device bundle (api/02-auth §5.2) — as structured records `{ algorithm: 'argon2id', salt (16 random bytes, new on every set/change/reset), params record, hash (32 bytes), asOf }`, mirrored into the client `user_pin_verifiers` directory table inside the SQLCipher DB. Two structural bounds hold by construction:

- **Verifier minimization (api/02-auth §5.1):** a device holds verifiers only for users of its **own store** — never the whole tenant's. No sync or bundle path replicates a tenant-wide verifier set to any device.
- **Nothing in the op log.** `auth.pin_changed` / `auth.pin_reset` payloads carry no hash material (api/02-auth §6.2); new verifiers travel only over TLS (`POST /v1/users/:id/pin-verifier`) and propagate via bundle refresh. An append-only, replicated-forever log must never contain a secret that cannot be rotated out of it — superseded verifiers therefore persist nowhere on other devices.

Consequence that remains, stated plainly: **an attacker who extracts the device DB holds the PIN verifiers of that store's OTHER users** and can brute-force them offline. This is inherent to offline-first shared-device auth; it is bounded and mitigated, not eliminated.

**Offline brute-force math (spell it out, keep it current with benchmarks):**

- PIN space: **6 digits, fixed in v0** (api/02-auth §6.1) = 1,000,000. (A 4-digit space falls in 20–40 seconds under the same math — which is why v0 fixed 6.)
- Per-guess cost at default params (argon2id m=32768 KiB, t=3, p=1, 32-byte output): ~100–250 ms on the 2 GB Android target; ~30–60 ms per lane on a commodity desktop core. Memory-hardness caps parallelism at RAM/32 MiB, but 16 cores × 32 GiB is ordinary hardware → ≈ 250–500 guesses/s.
- **Full 6-digit space ≈ 35–70 minutes on a commodity desktop. Expected crack ≈ half that (≈ 17–35 minutes).** At the documented floor (m=19456 KiB, t=2, p=1 — only if the on-device benchmark exceeds 300 ms), roughly 2–3× faster still: full space ≈ 12–35 minutes.
- Conclusion: **argon2id does not make a 6-digit PIN survive a dedicated offline attacker — it buys tens of minutes, not years.** Its jobs are: (a) making throttled on-device guessing slow, (b) per-user salts killing precomputation, (c) keeping the extracted-DB attack expensive enough to be deliberate rather than incidental. The controls that actually defend the bundle are SQLCipher + SecureStore (extraction requires app/device compromise first, §6), the escalating lockout (on-device guessing, api/02-auth §6.5), verifier minimization (a cracked DB exposes one store's users, not the tenant's), and blast-radius limits: a cracked PIN yields fraudulent *attribution on that one enrolled device* — every resulting op is still device-signed, logged, and the device is revocable.

- [ ] Verifier distribution is minimized by construction: the bundle delivers only the device's store's users (api/02-auth §5.1); the test seeds a multi-store tenant and asserts no other store's verifier ever reaches the device.
- [ ] **No verifier material in op payloads:** the `auth.pin_*` payload schemas carry no salt/hash fields, and SEC-AUTH-09 scans pushed payload bytes to prove it — the op log contains no PIN secret, rotatable or otherwise.
- [ ] Verifiers live inside the SQLCipher-encrypted DB (`user_pin_verifiers`), never in plaintext files or AsyncStorage.
- [ ] Verifier comparison is constant-time (quick-crypto `timingSafeEqual` equivalent), client and server.

### 5.3 Checklist

- [ ] **KDF:** argon2id via quick-crypto native, **async variant** (JS thread stays free), params `m=32768 KiB, t=3, p=1, 32-byte output`. Documented floor `m=19456, t=2, p=1` permitted ONLY if the on-device benchmark (part of the auth task, run on the 2 GB target) exceeds 300 ms — the chosen params are recorded in the verifier's params record so verification never guesses. A pure-JS KDF on device is forbidden (100x+ too slow on Hermes → devs would cut params; research JSON).
- [ ] PINs are never stored, logged, or transmitted in plaintext — the PIN itself never transits the network (api/02-auth §3); server and devices hold only the structured verifier record (§5.2). NFR-1004: never recoverable, reset-only.
- [ ] **Escalating lockout (FR-1011)** — schedule owned by api/02-auth §6.5, mirrored here: attempts 1–3 free; then delays 30 s → 60 s → 120 s → 300 s cap per attempt; the **10th** consecutive failure hard-locks PIN auth for that user on that device (states `unlocked → delayed → locked_out`). Attempts during a delay or lockout window are refused **without running the KDF** (`PIN_RATE_LIMITED` / `PIN_LOCKED`). State persists in the encrypted DB: `pin_attempt_state { userId, deviceId, consecutiveFailures, windowStartedAt, notBefore }` (10-db-schema §9.5).
- [ ] **Recovery is owner-mediated and offline-capable — there is no online self-recovery.** `locked_out` exits only via owner unlock (`auth.clearPinLockout`, permission `auth.pin_unlock`) or owner PIN reset (permission `auth.user_reset_pin`); both work offline (api/02-auth §6.5). A PIN-only user holds no server credential, so "online re-auth" is not implementable and must not appear in code or copy.
- [ ] **Lockout survives bypass attempts:** app kill/restart (persisted counter), device clock rollback (if now < stored `notBefore`, keep the stored value — never recompute downward), and data-clear (clearing app storage destroys SecureStore keys + DB → the device is effectively de-enrolled and must re-enroll online; there is no PIN to bypass).
- [ ] Honest availability trade documented in-code: a locked-out user stays locked out until a holder of `auth.pin_unlock` or `auth.user_reset_pin` acts on the device — no connectivity required. That is the designed behavior, not a bug.
- [ ] **PIN reset** is owner-role only (`auth.user_reset_pin` — main owner / store owner per PRD-011 §7), always an audited operation (`auth.pin_reset`), and the *target user* types the new PIN — a reset never reveals one (api/02-auth §6.6). Self-service reset does not exist in v0.
- [ ] **Privileged-target rule:** an `auth.pin_reset` targeting a user who holds the `main_owner` role requires the *actor* to hold `main_owner` — PIN-reset power is impersonation power, so a store owner must not be able to become the main owner; enforced at the command layer and push-validated server-side (05-operation-log §9, api/02-auth §6.6).
- [ ] **User switch is an operation** (`auth.user_switched`, FR-1014) — appended to the log like any other op, carrying the incoming `userId`.
- [ ] Per-attempt failure records stay in local `pin_attempt_state`; the op log carries the lockout events (`auth.pin_locked_out` with the failure count, `auth.pin_lockout_cleared`) — the tenant-synced, owner-visible brute-force evidence (FR-1045 spirit; api/02-auth §6.5).
- [ ] **Idle lock** (FR-1015): default 300,000 ms (5 min, OQ-1002), configurable per tenant, locks to the switcher, **preserves in-progress work** (PRD-011 §6.2 — a lock that loses work gets disabled by whoever can disable it).
- [ ] Permission checks remain command-layer and fail-closed (02-permissions owns; FR-1027/FR-1031) — the PIN switcher never grants anything permissions don't.

### 5.4 Required adversarial tests

| ID | Name | Asserts |
| -- | ---- | ------- |
| SEC-AUTH-01 | KDF params floor enforced | Verifier creation with params below the floor (e.g. m=8192 or t=1) → rejected at construction; params record round-trips into verification |
| SEC-AUTH-02 | escalating lockout schedule | 3 free attempts, then delays 30/60/120/300 s cap enforced exactly per api/02-auth §6.5; attempt during a delay window → refused without running the KDF (`PIN_RATE_LIMITED`) |
| SEC-AUTH-03 | lockout bypass: restart | Fail 5×, kill and relaunch app → counter and `notBefore` intact; next attempt still delayed |
| SEC-AUTH-04 | lockout bypass: clock rollback | Fail 5×, set device clock back 1 h → delay window does not shrink (stored `notBefore` wins) |
| SEC-AUTH-05 | lockout threshold → owner recovery | 10th consecutive failure → `locked_out`, `auth.pin_locked_out` op emitted, PIN path disabled for that user+device (`PIN_LOCKED`); owner unlock (`auth.clearPinLockout`) and owner PIN reset each restore it, both asserted **offline**; no online self-recovery code path exists |
| SEC-AUTH-06 | PIN reset authorization | Reset attempted without `auth.user_reset_pin` → `PERMISSION_DENIED` + denial logged; a forged `auth.pin_reset` op pushed anyway → rejected `SCOPE_VIOLATION` at push (api/02-auth §6.3); by store owner → succeeds, audited `auth.pin_reset` op emitted (no verifier material in the payload), old PIN invalid, new verifier (fresh salt) distributed via control plane + bundle |
| SEC-AUTH-07 | user switch attributed | Switch A→B emits `auth.user_switched`; ops after the switch carry `userId = B`; ops before carry A; the device chain continues unbroken across the switch (05 §4) |
| SEC-AUTH-08 | idle lock preserves work | Idle past timeout → switcher shown; in-progress form state survives unlock by the same user |
| SEC-AUTH-09 | verifier confidentiality | Verifiers exist only inside the SQLCipher DB (scan app storage in the test harness for salt/verifier bytes); no pushed op payload contains verifier material (scan payload bytes across a full pin change/reset cycle); comparison path is constant-time (statistical timing test on equal-length inputs) |
| SEC-AUTH-10 | on-device KDF benchmark recorded | The 2 GB-target benchmark harness runs argon2id at default params and asserts < 300 ms or triggers the documented floor decision — output committed as a build artifact, not folklore |
| SEC-AUTH-11 | privileged-target PIN reset | A store_owner-signed `auth.pin_reset` op targeting the main-owner-role holder → rejected `SCOPE_VIOLATION` at push (05-operation-log §9, api/02-auth §6.6); the same command attempted locally → denied at the command layer; a main_owner-signed reset of the same target → accepted and audited |

## 6. Surface: Device enrollment, keys & revocation

Mechanism: api/02-auth (enrollment flow), PRD-011 §3.3/§7. Stack facts: expo-secure-store (values < 2 KB; encrypted-at-rest storage, **not** a non-extractable-key enclave), react-native-quick-crypto Ed25519, op-sqlite `open({ encryptionKey })` (research JSON, expo + sqlite areas).

### 6.1 Checklist — enrollment

- [ ] Enrollment requires an authenticated user holding `auth.device_enroll` (owner roles; control-session flow per api/02-auth §4); there is no self-enrollment. Enrollment is audited — `identity_audit` row plus the device's genesis op `auth.device_enrolled` — binding device → tenant + store (FR-1016).
- [ ] Ed25519 keypair is generated **on the device** (quick-crypto `generateKeyPairSync('ed25519')`); only the public key is sent to the server at enrollment. The private key never leaves the device — not in sync, not in backups, not in logs.
- [ ] **Device token:** ≥ 128-bit CSPRNG value issued at enrollment, delivered once; server stores only its SHA-256 hash and looks it up by hash (a DB dump does not yield usable tokens). Token maps to exactly one device.
- [ ] Re-enrollment after data-clear or revocation mints a new `deviceId`, new keypair, new chain — a device identity is never resurrected (05 §4 chains are per-device and append-only).

### 6.2 Checklist — key storage (qualified claims only)

- [ ] Signing key and SQLCipher key live in expo-secure-store, each value < 2 KB. **Qualify every claim:** SecureStore is Android-Keystore-encrypted-at-rest storage whose values are readable back by app code — it is NOT a hardware enclave and keys are extractable by anything running as the app. The spec, code comments, and owner-facing material must not say "hardware-backed" without this qualification.
- [ ] Consequence accepted and mitigated, not hidden: **app-level compromise = signing-key compromise.** Mitigations: (a) revocation cuts the key off at next server contact; (b) the server-side `device_anomalies` alarm (§3.1 — a row per `BAD_SIGNATURE`/`CHAIN_BROKEN` rejection, surfaced on `GET /v1/devices`) catches a forger who lacks perfect chain state; (c) enrollment audit trail bounds which key ever spoke for which store.
- [ ] `requireAuthentication` (biometric-gated SecureStore) is NOT relied on in v0 (does not work in Expo Go, device support uneven); if added later it is defense-in-depth, not a load-bearing control.
- [x] Android auto-backup excludes the app's data (SQLCipher DB + prefs): `configureAndroidBackup` / backup rules. Keystore-held wrapping keys never back up, so a restored backup without the original device is unreadable anyway — exclusion removes the ambiguity. **Shipped (task 58) as SEC-DEV-08**, asserted against the GENERATED manifest, not `app.config.ts`: `android.allowBackup: false` (Expo writes `allowBackup="true"` when the config is silent, so this had to be stated) plus `expo-secure-store`'s `configureAndroidBackup` rules, which exclude the SecureStore prefs and — because Android backs up "only the files specified" once any `<include>` is present, and those rules include only `sharedpref` — the SQLCipher DB too, across `<cloud-backup>` **and** `<device-transfer>`, on both the 12+ and pre-12 paths. **`allowBackup: false` is not sufficient alone**: Android's docs say it does not disable device-to-device transfer for apps targeting 12+. **Residual risk, stated:** the exclusion is present in the shipped manifest; that it behaves as documented on a real restore is unverified on a **physical Android** (D12/D13) — no physical Android here, and an emulator cannot exercise a real Google Drive restore or device-transfer. This is the **Android** leg; the iOS backup-exclusion gap is **not the same size** — iOS has no runnable target of any kind here (task 80 §4) and no artifact-level exclusion mechanism at all (§6.6). **Note `keychainAccessible` does NOT contribute on Android** — it is an iOS-only option (see §6.2's overclaim rule); what holds on Android is that the Keystore wrapping key is hardware-bound and never backed up, so restored ciphertext is inert.
- [ ] **iOS backup exclusion: UNCOVERED, and no artifact-level control is possible — see §6.6 (task 84).** This checklist item is **Android-only**. iOS's only file-backup-exclusion mechanism, `isExcludedFromBackupKey`, is runtime-only and advisory (Apple: set via `setResourceValues` after the file exists, no Info.plist/entitlements form, and *"not a mechanism to guarantee those items never appear in a backup or on a restored device"*), so there is nothing to assert in a generated artifact and no iOS target here to run it on. The §7.4 "never resurrected" property still holds on iOS via `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`, but the DB file itself restores un-excluded (no artifact-level mechanism; expo-file-system 57 exposes no runtime API either) — a **P1 boot-brick on restore** (§6.6). SEC-DEV-08 stays Android-scoped (task 80's ruling); it is **not** extended to iOS and no new iOS SEC id is minted without a falsified producer.

### 6.3 Checklist — revocation

- [ ] Revocation is owner-role (`auth.device_revoke`), audited, and terminal: `Device.status: active → revoked` (03-state-machines; no un-revoke).
- [ ] Effect at the server is immediate: token `401`s, pushed ops → `DEVICE_REVOKED`, open realtime sockets for that device are closed (§9), pull refuses.
- [ ] **Honest latency caveat (PRD-011 §7), surfaced to owners in UI copy:** revocation is effective on the device's **next contact with the server**. An offline device keeps working locally until then; a device that never reconnects cannot be reached by software — repossession is a physical control. Never imply otherwise.
- [ ] FR-1019: ops signed **before** revocation remain valid and verifiable forever; revocation gates future acceptance only.
- [ ] Long-unsynced devices surfaced in device management (PRD-011 §6.5) — a silent device is lost, broken, or holding a week of unsynced ops.

### 6.4 Checklist — local DB encryption (SQLCipher key lifecycle)

- [ ] Key = 32 CSPRNG bytes (quick-crypto), generated **once at enrollment**, stored in SecureStore, passed to op-sqlite `open({ name, encryptionKey })` — never derived from any PIN (PINs are per-user; the DB is per-device), never logged, never synced, never leaves the device.
- [ ] Single op-sqlite connection app-wide (op-sqlite hard rule) opened through the thin DB wrapper; the wrapper is the only place the key is ever read from SecureStore.
- [ ] Key loss (SecureStore wipe, app data clear) = local data loss by design → re-enroll + re-pull from server. No key escrow, no recovery path — document as accepted.
- [ ] A DB file pulled off a device without SecureStore access is ciphertext; the adversarial test proves the file is not readable as plain SQLite.

### 6.5 Required adversarial tests

| ID | Name | Asserts |
| -- | ---- | ------- |
| SEC-DEV-01 | enrollment authorization | Enrollment attempted with a non-owner user's credentials → `403`, no device row, no token minted; with `auth.device_enroll` → succeeds + audited |
| SEC-DEV-02 | token hashed at rest | Server DB contains no plaintext device tokens (scan the devices table for the issued token value); auth works via hash lookup; a stolen DB row does not authenticate |
| SEC-DEV-03 | revocation latency semantics | Revoke device; its very next push/pull → `401`/`DEVICE_REVOKED`; ops it signed pre-revocation still verify on pull by other devices (FR-1019) |
| SEC-DEV-04 | offline-revocation caveat holds | Revoked-while-offline device continues local operation (documented behavior); on reconnect it **cannot sync** — push/pull → `401 DEVICE_REVOKED` at the auth middleware (api/02-auth §8/§9), nothing accepted — and its unsynced work is **wiped, not leaked or resurrected**: queued ops are held locally only until api/02-auth §7.3's confirm-then-wipe destroys them with the rest of the device data, by design (the loss mitigation is sync frequency, not retention). **(D18 §2, 2026-07-17 — over-specification removed):** the earlier "queued ops → `DEVICE_REVOKED`, kept + surfaced as `rejected`" wording is dropped — the wire 401s before any per-op rejection code runs, and "kept" contradicted §7.3's by-design wipe; marking queued ops `rejected` (terminal, 03-state-machines §3) on a 401 would let one spurious 401 destroy a shop's unsynced work, which §7.3's confirm-then-wipe exists to prevent |
| SEC-DEV-05 | private key never leaves device | Enrollment request payload, sync bodies, and logs contain no private-key material (harness intercepts all outbound requests during enroll + sync cycle) |
| SEC-DEV-06 | DB at rest is ciphertext | Copy the on-device DB file, open without key → not a valid SQLite database; open with wrong key → failure; grep of file bytes finds no seeded plaintext markers |
| SEC-DEV-07 | key compromise containment | Simulate extracted signing key: forge an op with correct signature but stale chain state → `CHAIN_BROKEN` + `device_anomalies` row recorded against the device and surfaced in `GET /v1/devices` anomaly counts (the documented §6.2 mitigation actually fires) |
| SEC-DEV-08 | auto-backup exclusion is present in the shipped Android build | Compile the real prebuild pipeline (`getPrebuildConfigAsync` + `compileModsAsync`, i.e. the artifact, never `app.config.ts`) and assert the generated `AndroidManifest.xml`: `android:allowBackup="false"`, and the `dataExtractionRules` (12+) / `fullBackupContent` (pre-12) references RESOLVE to rules on disk that exclude expo-secure-store's prefs and never `<include>` a domain that could carry `bolusi.db`, in **both** `<cloud-backup>` and `<device-transfer>`. Removing the exclusion, disabling `configureAndroidBackup`, widening an include to `database`, or deleting the resource each fails the check. **Scope, explicitly: this is the BUILD-ARTIFACT leg only.** It does not verify a real Google Drive restore or device-to-device transfer — there is no physical Android on this project (D12/D13), and no green here may be read as **Android-device-verified**. None of it speaks to iOS: SEC-DEV-08 is **Android-scoped** by task 80's ruling, and the iOS backup gap is a *separate, larger, mechanism-less* one (§6.6) — the two are not the same size. The on-device restore leg is unclaimed; it belongs with task 27's Android device-gates runner alongside SEC-DEV-06 |

### 6.6 Platform scope — the backup-exclusion checklist is Android-only; the iOS leg is UNCOVERED (task 84, under D17/D18 §3)

D17/D18 §3 make iOS a first-class, co-equal target, so this is stated rather than left implicit: **§6.2's backup-exclusion control (SEC-DEV-08) is Android-only, and — verified against Apple's docs — no artifact-level iOS counterpart is possible.** This is an *absence*, not a mis-claim: SEC-DEV-08's row already names "Android" and does not overclaim (task 80). It stays Android-scoped; extending it would let the green Android leg mark a two-platform guarantee shipped while iOS is unbuilt (a verbatim-id title retires an id — task 31), and no new iOS SEC id is minted before it has a falsified producer.

- **`isExcludedFromBackupKey` is the only iOS file-backup-exclusion mechanism, and it is RUNTIME-ONLY and ADVISORY.** Apple: it is set via `URL.setResourceValues(_:)` **after the file exists** — there is no Info.plist or entitlements form — and *"the `isExcludedFromBackup` resource value exists only to provide guidance to the system … it's not a mechanism to guarantee those items never appear in a backup or on a restored device."* So unlike Android's SEC-DEV-08 there is **nothing to assert in a generated artifact**, and there is **no iOS target of any kind here** (no iPhone, no macOS, no Xcode, no Simulator — task 85) to set it or observe it.
- **`NSFileProtection` is not backup exclusion, and was considered and rejected as a substitute.** The `com.apple.developer.default-data-protection` entitlement's background-safe value (`NSFileProtectionCompleteUntilFirstUserAuthentication`) is already the OS default for third-party apps — declaring it changes nothing (a well-typed no-op, T-15) — while `NSFileProtectionComplete` makes files unreadable while the device is locked, which **breaks background sync** (`expo-background-task`); Apple explicitly advises against the entitlement for apps that run in the background. Data protection is at-rest encryption, orthogonal to whether a file is copied into a backup. Shipping it as a "backup control" would be a false-assurance artifact — the anti-pattern §2.11 exists to stop.

**What DOES hold on iOS (the §7.4 leg that is delivered):** `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` (`ports/keystore.ts` + `ports/db-keystore.ts`, asserted in `keystore.test.ts`) keeps the Ed25519 seed, device token, and `db_encryption_key` out of encrypted backups, so a device identity is **never resurrected onto new hardware** — Expo's default `WHEN_UNLOCKED` *does* migrate, so this option is load-bearing. The call is asserted; its on-device effect is unverified (no iOS target; the suite mocks `expo-secure-store`).

**The live consequence the missing exclusion causes — and the Keychain leg cannot prevent — is a P1 (task 84's second finding; reported to the orchestrator, not fixed here).** On an iOS restore-to-new-hardware, `bolusi.db` **does** restore (it cannot be excluded at the artifact level) while `db_encryption_key` does **not** (THIS_DEVICE_ONLY). Bootstrap then reads no key → `SecureStoreDbKeyStore.ensureDatabaseEncryptionKey()` **mints a fresh key** → `openClientDb` opens the restored old-key file with the new key → SQLCipher throws `not_a_database` → `Root.tsx` (its `boot()` is deliberately not wrapped in try/catch) leaves `app === null` and **renders nothing, permanently, with no recovery path.** Android does not have this exposure: task 58 excludes the DB, so a restored Android device has no file and re-enrols cleanly. The customer is a phone-repair franchise; restore-to-new-hardware is near the median device event. The fix (catch `not_a_database` / `missing_key` at boot → wipe + re-enrol) is the bootstrap error surface owed to task 27a, not this backup-exclusion control.

**Premises this ruling rests on (named, per task 84 — a conclusion without its premise sits quietly wrong when the premise changes):** (1) the Android-first product history (`00-product-overview`); (2) every record is server-synced, so **nothing local is worth restoring** — the intended recovery is re-enrol + re-pull, not a backup restore; (3) the franchise's wipe / restore / hand-me-down device lifecycle; (4) no iOS runnable target exists on this infrastructure (task 85). If (2) is ever false (some local-only state becomes worth restoring) or (4) changes (an iOS build/verification lane appears), re-evaluate — the runtime `isExcludedFromBackupKey` call plus the boot recovery path become the iOS producer, and only then does an iOS SEC id earn its place.

## 7. Surface: Media pipeline

Mechanism: 06-media-pipeline (client pipeline) + api/03-media (wire protocol — media-id-keyed routes `init → PUT chunks → status → complete`; there is no separate upload-session id). Stack facts: hand-rolled chunked resumable upload (no native resumable upload in expo-file-system SDK 57; FileHandle offset + readBytes per chunk), server tracks received chunks (research JSON, expo area). States: server wire `receiving → complete` (api/03-media); the client machine `MediaItem.uploadStatus: pending → uploading → uploaded | failed` (03-state-machines) exists only client-side.

### 7.1 Checklist

- [ ] **Immutability by media id:** metadata (size, hash, mime, capture context) is pinned at `init` and has no update path — no mutation endpoint exists. Re-`init` with any differing field → `409 INIT_MISMATCH`; `init`/`PUT` against a `complete` id → `409 MEDIA_IMMUTABLE` (api/03-media §3.1/§5). There is no `405` anywhere on this surface.
- [ ] **Replace-after-attach forbidden (FR-819):** a `complete` media id can never be re-initialized, re-chunked, or replaced — `409 MEDIA_IMMUTABLE`; blob keys are written once. Correcting a photo = new media id + new operation with a reason.
- [ ] Content hash (SHA-256) declared at `init`; server verifies the assembled bytes against it at `complete` (`422 HASH_MISMATCH` ⇒ stored chunks purged, nothing enters the blob store) — a chunk-level attacker cannot swap content under a committed hash.
- [ ] **Upload binding:** an in-flight upload is bound to the creating device (`uploader_device_id`) + tenant; `init`/`PUT`/`status`/`complete` against it from another device or tenant → `404` (api/03-media §2).
- [ ] **No client input touches a filesystem path.** Blob keys are server-generated (`t/{tenantId}/m/{mediaId}`, api/03-media §6); the only client-controlled path parts are `:id` (UUID-validated) and `:index` (bounded integer, `0 ≤ i < totalChunks` → `422 CHUNK_INDEX_INVALID`), and neither is ever concatenated into a filesystem path.
- [ ] **Size and type validation:** `sizeBytes` capped at 10 MiB at `init` (`413 MEDIA_TOO_LARGE`); every chunk's byte count is exact-match (`422 CHUNK_SIZE_INVALID`, `bodyLimit` backstop) so over-sent bytes can never accumulate; mime allowlist {`image/jpeg`, `image/png`} at `init` (`422 MIME_UNSUPPORTED`); **magic-byte sniff at `complete` must match the declared mime** (`422 MIME_MISMATCH`, chunks purged — api/03-media §3.4).
- [ ] Chunk bodies are raw bytes: `Content-Encoding: gzip` on a chunk `PUT` → `415 UNSUPPORTED_ENCODING` (the sync gzip middleware is not mounted on media routes — api/03-media §7).
- [ ] **Download scope is device-scoped** (api/03-media §2 = the pull-scope rule, api/01-sync §4.1); every out-of-scope, in-flight, or nonexistent id → `404 MEDIA_NOT_FOUND`, indistinguishable — the documented §2.2 exception to FR-1036. No unauthenticated or "unguessable URL" access — media ids are not capabilities. If pre-signed URLs are ever introduced they get their own checklist revision first.
- [ ] Client-side: captured file moves cache → document dir immediately (cache is OS-purgeable; a purged evidence photo is destroyed evidence); foreground drain loop is the upload driver; expo-background-task is opportunistic only.

### 7.2 Required adversarial tests

| ID | Name | Asserts |
| -- | ---- | ------- |
| SEC-MEDIA-01 | replace after attach → 409 | Upload media to `complete`, attach it to an op, then re-`init` and `PUT` different bytes to the same media id → `409 MEDIA_IMMUTABLE`; stored blob byte-identical before/after |
| SEC-MEDIA-02 | metadata immutable | Re-`init` with each field varied (sizeBytes, sha256, mime, metadata) against a `receiving` id → `409 INIT_MISMATCH`; against a `complete` id → `409 MEDIA_IMMUTABLE`; route-table walk finds no metadata-mutation endpoint; stored metadata identical before/after |
| SEC-MEDIA-03 | out-of-scope download probe → 404 | Four legs, all `404 MEDIA_NOT_FOUND` with indistinguishable responses: tenant B's media id; same-tenant media of an unassigned store; a `receiving` (incomplete) id; a nonexistent id. Authorized + `complete` → `200` (§2.2 documented exception) |
| SEC-MEDIA-04 | path/param fuzzing | `:id` values `../../etc/passwd`, `..%2f..`, absolute paths, non-UUID strings → `422 VALIDATION_FAILED` (param schema), nothing stored; `:index` of −1, `totalChunks`, 2^31 → `422 CHUNK_INDEX_INVALID`; blob files exist only under the server-generated storage root (fs assertion) |
| SEC-MEDIA-05 | content validation at complete | Declared `image/jpeg` with non-JPEG magic bytes → `422 MIME_MISMATCH` at `complete`, chunks purged, media never `complete` (code owned by api/03-media §3.4); bit-flipped chunk → `422 HASH_MISMATCH`, stored chunks purged, blob store untouched; chunk byte count ±1 → `422 CHUNK_SIZE_INVALID`, nothing stored |
| SEC-MEDIA-06 | cross-device chunk injection | Chunks `PUT` to another device's in-flight media id with a valid (different-device) token → `404 MEDIA_NOT_FOUND`; the real upload's `receivedChunks` unpolluted |

## 8. Surface: Tenant isolation

Mechanism: two mandatory layers (decisions D3, research JSON kysely area): (1) `forTenant(tenantId)` wrapper factory — the ONLY exported way to query tenant tables; (2) Postgres RLS `USING (tenant_id = current_setting('app.tenant_id')::uuid)` with **transaction-local** `set_config('app.tenant_id', $1, true)` at the top of every request transaction. FR-1038..FR-1041.

### 8.1 Checklist

- [ ] **RLS enabled AND forced on every tenant table:** `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` (FORCE so even the table-owning role is subject — a misconfigured app role must not bypass). Policies for SELECT/INSERT/UPDATE/DELETE all carry the tenant predicate; INSERT uses `WITH CHECK`.
- [ ] Migration convention: every new tenant table's migration enables + forces RLS and creates policies **in the same migration** — SEC-TENANT-01 makes forgetting fail CI, but the convention keeps failures rare.
- [ ] **`forTenant` is the only query path:** the raw Kysely handle is not exported from the DB package; ESLint `no-restricted-imports` (plus a package-boundary export check) forbids importing the raw handle or `pg` outside the DB package. Allowlist: migrations and the RLS test harness only.
- [ ] **`set_config(..., true)` (is_local) inside an explicit transaction, always.** Session-level `SET app.tenant_id` is forbidden (pooled connections leak tenant context across requests — research JSON kysely caveat). Lint/grep in CI rejects `set_config` with `false` and bare `SET app.tenant_id` anywhere in the codebase.
- [ ] Missing/empty `app.tenant_id` fails closed: RLS predicate `current_setting('app.tenant_id')` on an unset GUC must error or match nothing — verified by test, not assumed (use `current_setting('app.tenant_id', true)` semantics deliberately and test the unset case).
- [ ] **No cross-tenant access path** (FR-1040): no support/admin ambient capability exists in v0. Platform support access, if ever built, is explicit, logged, consented impersonation — its own future spec, red-flagged per CLAUDE.md §6.
- [ ] Endpoint semantics per §2.2: cross-tenant probes → `404`, never empty-200.
- [ ] Client DB is single-tenant by construction (one device = one tenant), but shared TS query code still goes through the tenant-bound handle shape so it cannot silently grow a cross-tenant parameter.

### 8.2 Required adversarial tests

| ID | Name | Asserts |
| -- | ---- | ------- |
| SEC-TENANT-01 | RLS coverage sweep | Automated test enumerates all tables in the app schema (allowlist for genuinely global tables, e.g. migrations bookkeeping); asserts `rowsecurity = true` AND `relforcerowsecurity = true` AND tenant policies exist for all four verbs; a new unprotected table fails CI |
| SEC-TENANT-02 | RLS enforcement probe | With `app.tenant_id = A`: SELECT on B's rows → 0 rows; INSERT with `tenant_id = B` → error (`WITH CHECK`); UPDATE/DELETE targeting B's rows → 0 affected |
| SEC-TENANT-03 | wrapper-only query path | Lint fixture importing the raw DB handle outside the DB package fails CI; repo-wide grep for `set_config(.*false)` and `SET app.tenant_id` is clean |
| SEC-TENANT-04 | cross-tenant probe per endpoint | Harness iterates **every registered route** (walks the Hono route table — new endpoints are covered automatically) with tenant-A credentials against tenant-B resource ids → `404`/`403` per §2.2; any `200` (including empty-200) fails |
| SEC-TENANT-05 | pooled-connection leak | Two sequential transactions on the same pool connection for tenants A then B: B's transaction sees zero A rows and `current_setting` returns B; a request that skips `set_config` (harness bypass) reads **nothing**, not everything |

## 9. Surface: Realtime & push

Mechanism: api/00-conventions §12 (realtime channel) + api/04-push (push categories, payload composition, token registration). Stack facts: `upgradeWebSocket` from @hono/node-server 2.x + `ws` (`@hono/node-ws` is deprecated — never reference it); SSE fallback via `streamSSE`; client polling fallback; expo-notifications + FCM HTTP v1 (research JSON, hono + expo areas). Correctness never depends on realtime or push (api/01-sync §8) — they only trigger pulls and route attention.

### 9.1 Checklist

- [ ] **WS auth happens at upgrade:** the device bearer token is validated (same `verifyToken` path as sync) **before** the upgrade completes; invalid/revoked token → HTTP `401`, no socket. Tokens travel in the auth header (or first-message auth if RN WebSocket headers prove unreliable — decide in api/00-conventions; never in the query string, which lands in access logs).
- [ ] The WS route carries no header-mutating middleware (CORS etc.) — `upgradeWebSocket` mutates headers internally and combining them throws (research JSON hono caveat).
- [ ] **Revocation closes sockets:** the revocation handler terminates all open WS/SSE connections for the revoked device immediately (§6.3).
- [ ] **Realtime carries pokes only:** every WS/SSE message is exactly the frozen `{ type: "sync.poke" }` shape (api/00-conventions §12). No entity data, names, amounts, or ids. The WS channel must not become a second, less-audited data plane; data always flows through authenticated pull.
- [ ] **Push payloads never carry business data values** (api/04-push): a push is `category` (v0: `sync` | `conflict` | `device`) + a **server-composed, localized, generic** title/body (target user's `platform.user_locale` pref, fallback `id-ID`) + a deep-link route key carrying **entity ids only**. Never amounts, user or customer names, note bodies, or any other business data value — FCM payloads transit Google's infrastructure and land in the OS notification layer outside the app's encryption boundary. Entity ids in the deep link are the ceiling.
- [ ] Client→server WS messages are schema-validated (shared Zod — `hc`'s `$ws()` does not type message payloads; research JSON hono caveat) and unknown messages are dropped + counted, never processed.
- [ ] SSE fallback authenticates identically; poke fan-out is tenant/store-scoped exactly like pull scope (api/01-sync §4.1) — a device must not even learn *that* another tenant has activity.
- [ ] Expo push tokens are registered via `POST /v1/push/tokens { expoPushToken, deviceId }` (api/04-push), stored server-side keyed to device, deleted on revocation; `getExpoPushTokenAsync` re-registration on token rotation.
- [ ] Per-connection limits: max 1 concurrent WS per device token; server ping/idle timeout closes dead sockets.

### 9.2 Required adversarial tests

| ID | Name | Asserts |
| -- | ---- | ------- |
| SEC-RT-01 | unauthenticated upgrade refused | WS upgrade with missing/invalid token → `401`, no socket established; same for SSE endpoint |
| SEC-RT-02 | revocation closes the socket | Open WS as device D, revoke D → socket closed by server (bounded by test timeout ≤ 5 s); reconnect attempt → `401` |
| SEC-RT-03 | poke & push payload audit | Schema test over every server code path that emits WS/SSE/push messages: WS/SSE payloads validate against the frozen `{ type: "sync.poke" }` schema (api/00-conventions §12); push payloads validate against api/04-push's shape (category + localized generic title/body + deep-link entity ids); a fixture payload carrying a business data value (amount, name, note body) fails the suite |
| SEC-RT-04 | poke fan-out scope | Activity in tenant B / other store produces zero pokes to a tenant-A store-1 device (WS, SSE, and push legs) |
| SEC-RT-05 | client message hardening | Oversized, malformed, and unknown-type WS messages from a client → dropped, connection stays healthy, no server exception; flood of messages → connection closed per limits |

## 10. Secrets handling

- [ ] **No secrets in the repo, ever.** `.env` is gitignored; `.env.example` (placeholder names, no values) is committed and is the authoritative list of required env vars. Server config is read once at boot through a Zod-validated config module — no ad-hoc `process.env` reads scattered through code.
- [ ] **`EXPO_PUBLIC_*` never carries secrets** — those values are bundled into the APK and are world-readable. The client app holds no API secrets at all: its only credentials are the per-device token and keys in SecureStore.
- [ ] FCM service-account JSON lives in EAS credentials/secrets only; `google-services.json` contains identifiers, not secrets, but is still not committed (EAS-managed).
- [ ] Server-side at-rest rules: device tokens hashed (§6.1); PIN verifiers argon2id (§5); no secret material in logs — a log-redaction test greps captured logs from a full enroll+auth+sync integration run for token values, PINs, and key bytes (**SEC-SECRET-01**).
- [ ] Pre-commit secret scanning (gitleaks or equivalent) runs in the mandatory pre-commit hooks (CLAUDE.md §2.10) and in CI (**SEC-SECRET-02**: CI job exists and a fixture secret is caught).
- [ ] Database connection strings, RLS-bypassing superuser credentials, and migration credentials are distinct from the app role's — the app role cannot `ALTER TABLE` or bypass RLS (ties into SEC-TENANT-01/02).

## 11. Dependency posture

- [ ] **Exact pins** (no caret) for the load-bearing set: `kysely@0.29.3` (0.x minors break), `@hono/node-server@2.0.8` (young 2.x line), `canonicalize@3.0.0` (byte-identical JCS output is a correctness invariant — the op hash depends on it), `@op-engineering/op-sqlite@17.1.2`, `react-native-quick-crypto@1.1.6`, `hono@4.12.30`, `zod@4.4.3`, `@hono/zod-validator@0.8.0`, `@noble/curves@2.2.0`, `@noble/hashes@2.2.0`, `kysely-generic-sqlite@2.0.0`. `pnpm-lock.yaml` committed; CI installs `--frozen-lockfile`.
- [ ] One `zod` version in the lockfile (duplicate v3/v4 breaks validator types — research JSON hono caveat); a lockfile check asserts it.
- [ ] Version bumps are deliberate PRs that re-run the full `SEC-*` suite; JCS vector tests (SEC-OPLOG-06) and crypto interop tests are the tripwire for behavioral drift in `canonicalize` and the crypto pair. Never auto-merge dependency updates.

### Single-maintainer risk register

| Package | Risk | Mitigation |
| ------- | ---- | ---------- |
| `@op-engineering/op-sqlite` | Single maintainer (bus-factor); native module | Thin DB-access wrapper is the only import site; `expo-sqlite` stays a documented swap target (research JSON sqlite recommendation); exact pin |
| `canonicalize` | Single maintainer, multi-year release gaps | RFC 8785 is frozen — low churn is acceptable; exact pin; RFC vectors in CI on Hermes catch any behavioral change on bump |
| `kysely-generic-sqlite` (client dialect shim) | Small community package | Shim code is small enough to vendor if abandoned; exact pin; dialect-neutral applier test suite (04-module-contract §2) catches drift |
| `kysely-expo` | n/a — **not used** | We ship a custom op-sqlite shim via kysely-generic-sqlite; no official op-sqlite Kysely dialect exists, and kysely-expo targets expo-sqlite + tracks Expo SDK majors in lockstep — recorded here so nobody adds it "for convenience" |
| `react-native-quick-crypto` | Native module, New-Architecture-coupled | Audited 1.1.x line; @noble interop suite in CI detects signature/hash drift; crypto access behind a provider interface (research JSON crypto caveat) |

## 12. Test index

Every `SEC-*` ID above is REQUIRED and enforced by SEC-META-01 (§2.1). Roll-up: OPLOG 01–09 · SYNC 01–10 · AUTH 01–11 · DEV 01–08 · MEDIA 01–06 · TENANT 01–05 · RT 01–05 · SECRET 01–02 · META 01. The chaos harness (testing-guide, decisions D4) covers correctness-under-disorder; this suite covers correctness-under-malice. Both gate v0 exit.
