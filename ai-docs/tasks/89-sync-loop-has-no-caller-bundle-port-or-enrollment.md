# TASK 89 — the sync loop can never start: `BundleRefreshPort` has no producer, enrollment has no caller, NetInfo is unpinned

**Status:** todo
**Priority:** **HIGH** — task 15 shipped a correct sync loop that nothing can construct or start. Every staleness banner on every device is permanent until this lands.
**Depends on:** 14, 15, 50, 88
**Blocks:** 25, 27a

## The finding (task 50, 2026-07-16)

Task 50 wired the bootstrap and built the sync transport + trigger adapters, then could not start the loop. Four independent producers are missing, each owned elsewhere. Traced (T-16), not assumed:

### 1. `BundleRefreshPort` — zero producers

`packages/core/src/sync/ports.ts:72` declares it; `loop.ts:82` requires it (`readonly bundle: BundleRefreshPort`) and calls `this.options.bundle.refresh()` once per cycle. `grep -rn "BundleRefreshPort|refreshBundle"` over `packages/core/src` + `apps/mobile/src` returns **only the declaration, the loop's consumption, and its own re-export**. Nothing implements it.

Its own docblock names the owner and the owner did not ship it:

> *"DELIBERATELY A HOOK, NOT A BUNDLE TRANSPORT. **Task 14 owns bundle fetching, ETag handling and `applyBundle`**"*

Task 14 (**done**) shipped `applyBundle` — the *apply* half. The *fetch* half (`GET /v1/devices/me/bundle` with `If-None-Match` → `304`/`200`, api/02-auth §5.2) does not exist: `grep "devices/me/bundle"` finds it only in comments. `SyncLoop` is not constructible without it.

### 2. Enrollment has no caller

`App.tsx` wires `onLogin={noop}` / `onEnroll={noop}`. `runEnrollment` (`packages/core/src/auth/enrollment.ts`) has **zero production callers** — the "11 sound tests and zero callers" shape CLAUDE.md §2.11 names. So no device obtains a device token, and the transport task 50 built fails closed with `AUTH_TOKEN_MISSING` on every call, correctly and forever.

### 3. `deviceId` is never persisted — **task 88**, filed separately

`SyncLoopOptions.deviceId` has no stored source. See task 88.

### 4. Trigger (a) — NetInfo — is unpinned

`api/01-sync §5` requires five triggers. Task 50 built (b) 3 s append debounce, (c) 60 s foreground interval, (e) manual. **(a) connectivity is not buildable**: `@react-native-community/netinfo` is not installed and is **not in `08 §2.2`'s dependency table**, so adding it is a spec-table change requiring a stop-and-ask (CLAUDE.md §4/§6). **(d) background task** is deferred: the deps are installed, but `TaskManager.defineTask` is a process-global registration and **task 82 owns "background-task registration"** — two files defining tasks independently is a collision.

**What (a)'s absence costs, measured rather than hand-waved:** `loop.ts`'s `EARLY_EXIT_REASONS` is `{manual, connectivity}` (03 §10). With no connectivity trigger, a device inside a 5-minute backoff waits out the timer unless a human presses refresh — a periodic tick is *deliberately absorbed*. It costs latency on a bad-network shop, never data. `apps/mobile/src/bootstrap/triggers.test.ts` asserts this absence rather than describing it, so wiring (a) turns that test red — which is the intent.

## Why the pieces already built do not make this half-done

Task 50 shipped `transport.ts` and `triggers.ts` with tests, and neither has a production caller today. That is the zero-callers shape, and it is stated here rather than hidden: they are correct, tested units waiting on §§1–3. **Do not read their green as evidence that sync works.** The honest summary is in `Root.tsx`'s header and in `bootstrap.ts`'s: `Root.tsx` passes `loopState: 'idle'` and `isOffline: true` because there is no loop — both are the true state of a device with no sync client, not placeholders.

## Docs to read

- `api/02-auth.md` §5.2 (`GET /v1/devices/me/bundle` — the ETag contract), §4.1–§4.3 (enrollment).
- `api/01-sync.md` §5 (the five triggers), §6 (the loop).
- `03-state-machines.md` §10 (`EARLY_EXIT_REASONS`, `syncDisabled` has no automatic exit).
- `packages/core/src/sync/ports.ts` (`BundleRefreshPort`'s docblock — read why it is a hook and not a transport; do NOT re-declare bundle fetching inside it, §2.8), `loop.ts` (`SyncLoopOptions`).
- `apps/mobile/src/bootstrap/transport.ts`, `triggers.ts`, `bootstrap.ts`, `Root.tsx` — what task 50 built and what it left absent, stated in each header.
- `ai-docs/tasks/88-*.md` — **read first**; the loop needs a `deviceId` and 88 is what produces one.
- `testing-guide.md` T-14b, T-16, T-19.

## Acceptance

- A cold boot on an **enrolled** device constructs the loop, `hydrate()`s it, starts the triggers, and drives a real push/pull cycle against a fake transport with **zero sockets** (T-6).
- **`304` is a SUCCESS.** `BundleRefreshPort.refresh()` resolves `'unchanged'` on 304 and `'refreshed'` on 200. Falsify: make 304 throw and watch a steady-state device fall into permanent backoff — that is the bug this rule exists to prevent, and a test must witness it.
- **The sync-status screen's freshness becomes real.** After a successful cycle, `lastSuccessfulSyncAt` is a real timestamp read from `sync_state` and the staleness tier de-escalates from `stale`. Task 50 made the READ real; this makes the VALUE real. **No `?? Date.now()` anywhere on the path** (T-19).
- `Root.tsx`'s `loopState` and `isOffline` stop being literals and start being read from the live loop. Delete their "there is no loop" comments when the loop exists — a comment is a hypothesis (§2.11).
- **Trigger (a)**: either add NetInfo to `08 §2.2` via a stop-and-ask **or** state its absence and leave `triggers.test.ts`'s absence assertion standing. Do not fake a connectivity signal from the loop's own failures — that is a guess wearing a fact's clothes.
- **Falsify** each wiring (§2.11): break the bundle port → RED; break the transport → RED; break the trigger → RED. Report as "broke X, saw Y fail, reverted", never "the tests pass".
