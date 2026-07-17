# TASK 92 — the mobile command-runtime composition + the enrollment caller: a production device cannot enroll

**Status:** done
**Priority:** **HIGH** — this is the layer BELOW task 89's four producers. With 88+89 landed, the sync loop is real and starts on an enrolled device — but nothing lets a production device BECOME enrolled, so on real hardware the loop never starts. It also blocks the notes module (task 25), the first surface to run commands.
**Depends on:** 14, 50, 88, 89
**Blocks:** 25, and the production-enrollment path of 89

## The finding (task 89, 2026-07-17 — traced one layer deeper than task 50, T-16)

Task 50's review named four missing producers for the sync loop (task 89). Three were buildable and shipped (88 + 89: `BundleRefreshPort`, the `SyncLoop` construction, NetInfo). The FOURTH — "an enrollment caller for `runEnrollment`" — was traced to a producer during task 89 and found to have its own unproduced dependency, which task 50 did not name (T-16: a mention is not a producer; trace to one).

`runEnrollment` (`packages/core/src/auth/enrollment.ts`) appends the genesis op (`auth.device_enrolled`, seq 1, §4.1 step 6) through `deps.runtimeFor(device)` → a full **`CommandRuntime`**. A `CommandRuntime` requires an **`OpAppendStore`** (`packages/core/src/oplog/append.ts:37`).

> **There is NO production `OpAppendStore` anywhere in the repo — only test fixtures** (`grep -rl OpAppendStore` over `src` returns core's interface + tests; the producers are `packages/core/test/**/_harness.ts`, `_fixtures.ts`). Nothing composes a `CommandRuntime` in `apps/mobile` (no `new CommandRuntime` / `createModuleRuntime` call outside core's factory; db-client binds no append store).

**Consequence, measured:** even with all of task 89 wired, a production device cannot run the genesis append, so task 88's `deviceId` never persists on real hardware, so `bootstrap().deviceId` is `null`, so `createSync` returns `null` and the loop is never started. The "app does not sync" gap has a root one layer below the four producers — and it is a **§2.5 security surface** (op signing, the hash chain, genesis rules), which is why task 89 did NOT fold it in: it deserves its own review, and it is unverifiable in the sync-loop lane.

## The enrollment caller's OTHER two blockers (also traced during task 89)

The enrollment caller is not just `runtimeFor`. `App.tsx`'s `onLogin`/`onEnroll` are still `noop` (task 50 flagged this), and wiring them needs:

1. **A login transport** producing the wizard's `LoginResult` (`screens/enrollment/model.ts`). **The server's `LoginRes` (`apps/server/src/routes/auth.ts:97`) has no `tenantName`** — only `controlSession, expiresAt, tenantId, user, stores` — but `LoginResult.tenantName` is required (the confirm step's `bindingSummary` renders it). A login transport cannot populate it without inventing it. **Reconcile the shape** (add `tenantName` to `LoginRes`, or drop it from the wizard) — a doc + server + client decision.
2. **An enroll transport** (`EnrollTransportPort`, `POST /v1/devices/enroll`) — buildable, but pointless to ship alone: it feeds `runEnrollment`, which needs #the runtime above.
3. **Unverifiable here**: there is no running server or device in this lane, so the whole flow's E2E is owed to **27a** (D12/D13). Building the transports without a way to run them would be three more untested adapters.

## The work

- **`OpAppendStore` over db-client** — `readChainHead` / `hasOp` / `insertOp` inside `ClientDb.transaction` (the shape `packages/core/test/auth/_harness.ts`'s `SqliteOpStore` models; promote it to production, do not copy it — §2.8). **Security surface (§2.5): ships adversarial tests BEFORE review** (genesis rules, `previousHash` chaining, signature over the signed core).
- **`createModuleRuntime` composition** in `apps/mobile` — the `CommandRuntime` + `QueryRuntime` pair (`packages/core/src/module/runtime.ts`), over the boot's registry + engine, with the `PermissionEvaluator` (`createDirectorySource` + `prime`), the `SecureStoreKeyStore` as the `SigningKeyPort` (it already satisfies it — keystore.ts), `systemClock`, `quickCryptoPort`, the UUIDv7 id source, the `LocationPort`, and the triggers' `scheduler` as the `SyncSchedulerPort`.
- **`runtimeFor`** = a factory closing over the above for the enroll response's device identity.
- **The login + enroll fetch transports** + reconcile `LoginRes.tenantName` (blocker #1).
- **Wire `App.tsx` `onLogin`/`onEnroll`** to the flow; on enroll SUCCESS, construct the sync client live (task 89's `createSyncClientForApp`) — Root re-derives `deviceId` after enrollment, so the loop starts without a reboot. The `evaluator.onBundleRefresh()` seam that `bundle.ts`'s `onBundleRefreshed` exposes is wired to this evaluator here (it is `undefined` today by design).

## Docs to read

- `packages/core/src/oplog/append.ts` (`OpAppendStore` / `OpAppendTx`), `packages/core/test/auth/_harness.ts` (`SqliteOpStore` — the shape to promote), `packages/core/src/module/runtime.ts` (`createModuleRuntime`), `packages/core/src/runtime/execute.ts` (`CommandRuntimeOptions`).
- `packages/core/src/auth/enrollment.ts` (`runtimeFor`, the genesis step), `apps/mobile/src/bootstrap/sync-client.ts` (`createSyncClientForApp` — the construction to call on enroll success), `apps/mobile/src/bootstrap/bundle.ts` (`onBundleRefreshed` — the memo-invalidation seam).
- `api/02-auth.md` §4.1–§4.3 (enroll), §4.2 (login + the `tenantName` gap), §5.3 (verifier params for signing).
- `security-guide.md` (op-log / signing surface), `testing-guide.md` T-11/T-14/T-16.

## Acceptance

- A `CommandRuntime` composed in `apps/mobile` appends a real, signed genesis op through the production `OpAppendStore` (adversarial tests: tampered signature rejected, genesis rules enforced, chain `previousHash` correct).
- `runEnrollment` runs end-to-end through it (login → enroll → bundle persist → genesis → task 88's `deviceId`/`storeId` persist), and on success the sync loop (task 89) starts — `lastSuccessfulSyncAt` becomes real without a reboot.
- `LoginRes.tenantName` reconciled (spec + server + client agree) — the wizard's confirm step renders a real tenant name.
- On-device E2E (`eas build`, cold boot, enroll) remains owed to **27a** — this task closes the headless-composable half; state the device half as owed (D12/D13).

## Carry-in from review-89 (non-blocking on 88/89; YOUR lane)

`apps/mobile/index.ts` has `API_BASE_URL = process.env['EXPO_PUBLIC_API_URL'] ?? ''` — an empty-string fallback that yields **relative URLs** if the env var is unset (T-19's shape: `?? ''` on a value you failed to read). It is latent today because it sits behind the unenrolled gate (`createSync` returns null until enrollment wires up — this task), so no production device reaches it yet. **When this task composes the login+enroll transports, fix it** — an unset API URL should fail loudly at boot, not silently POST to a relative path. Same family as the `??`-laundering this session filed as T-19.
