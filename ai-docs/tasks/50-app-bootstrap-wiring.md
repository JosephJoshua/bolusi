# TASK 50 — the app shell boots, the data layer doesn't: DB open, migrations, module registration, transport, sync triggers
**Status:** todo
**Priority:** HIGH — v0's exit runs through task 25 (notes) and 27a (emulator lane), and neither can run against a shell with no data layer.
**Depends on:** 15, 18, 24

## Goal

Complete `Root.tsx`'s bootstrap: open the encrypted DB, run client migrations, register modules, wire the transport, and connect the sync triggers — the half of task 24's acceptance item (2) that could not be built yet.

## The finding (task 24's own report, 2026-07-15)

Task 24 shipped the **shell** — the zone gate, session controller, and all five screens — and explicitly did **not** ship the bootstrap:

> *"The DB open + migrations, module registration, transport, and sync trigger adapters are **not built**. `Root.tsx` boots the shell, not the data; the app opens on the enrollment wizard."*

**It left them absent rather than stubbed, and that was the right call:**

> *"A fake `open()` returning a working-looking handle is precisely the green-for-the-wrong-reason shape."*

A stub here would have been the most dangerous kind: `Root.tsx` would boot, the screens would render, the tests would pass, and **nothing would be persisted**. The app would look finished. Absence is loud; a working-looking fake is silent.

**And the shell is honest about the gap by construction.** `Root.tsx` passes `lastSuccessfulSyncAt: null` — task 24's words: *"not a convenient placeholder but the **true state** of a device with no sync client"*. `03 §8` maps that to `stale`, so the shell shows the loud never-connected banner rather than a cheerful fake `fresh`. The absence is visible in the UI, not hidden behind a default.

**Why it couldn't be built:** the transport and sync-trigger adapters need **task 15** (sync-client, in flight); media queue wiring needs **task 18**. Task 24 correctly refused to guess at their shapes.

## Docs to read

- `apps/mobile/src/Root.tsx` — what boots today, and what doesn't. Read task 24's `zone.ts` first: the shell is a **gate** (a pure function of device status + session + lock), not a route graph, *"so an idle lock can't strand a screen behind a stale route."* Don't break that property.
- `apps/mobile/src/sync/contract.ts` — task 24's **declared local stopgap** for `SyncState` + staleness thresholds. `03 §8` says these live in `@bolusi/core`; task 24 shaped them so deletion is *"a repoint, not a rewrite"*. **Delete it and repoint** once task 15 has landed the real ones (§2.8 — do not keep both).
- `08-stack-and-repo.md` §2.2 — op-sqlite config (`sqlcipher: true`, `performanceMode: true`), and the **exactly ONE open connection per DB app-wide** rule. That constraint is not advice; violating it is a data-corruption bug.
- `10-db-schema.md` §9 (client tables), `packages/db-client` migrations.
- `04-module-contract.md` §4 (module registration — **client side**; note `ai-docs/tasks/49-*.md` covers the *server* registration list and is a different surface, but read it: both need one registry, not two).
- `03-state-machines.md` §8 (SyncState — the contract `Root.tsx` feeds).
- `api/02-auth.md` §3 (device key + SQLCipher key in expo-secure-store — *"app-readable, NOT a non-extractable enclave"*).

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `apps/mobile/src/Root.tsx` + bootstrap adapters. **Coordinate:** task 24's shell, task 15's sync client, task 18's media queue all meet here.

## Acceptance

**Observable done-condition:** a cold boot opens the encrypted DB, migrates it, registers modules, and drives a real sync — and the sync-status screen's freshness comes from a **real** `lastSuccessfulSyncAt`, not `null`.

- **Do not stub anything into looking finished.** If a piece still can't be built, leave it **absent** and say so — task 24's standard. A `Root.tsx` that boots against a fake handle is the single most expensive lie available here, because every downstream test would go green.
- **The SQLCipher key path is a security surface** (§2.5): the key comes from `expo-secure-store`, and `api/02-auth §3` is explicit that this is *encrypted-at-rest storage, **not** a non-extractable enclave*. Do not let a comment claim otherwise — **five false claims-in-comments have shipped here** (task 10's brand, task 11's "dialect-neutral" docblock, task 41's lock ordering, task 45's stale DELETE, task 49's push-sequence header). Ship the adversarial tests before review.
- **One connection, app-wide** (08 §2.2). **Falsify it** (§2.11): open a second connection, watch a guard fail. If nothing fails, the rule is a comment, not a constraint — and op-sqlite's own docs make this a correctness requirement, not a style preference.
- **Migrations run on a real device DB, not a fake.** Note the lane trap: `@bolusi/i18n` and `@bolusi/core` resolve via `dist/`, and task 24's own i18n falsification **stayed green** until it mutated `dist` instead of `src` (T-14c). Interrogate your oracle before believing any green.
- **Delete `src/sync/contract.ts`** and repoint to `@bolusi/core` once task 15 lands (§2.8). Confirm the thresholds still match `03 §8` — task 24's test **parses them out of the spec's own table** rather than restating them (T-13); keep that.
- **The zone gate must still be a pure function** of device status + session + lock, with device status checked **first and unconditionally** (revocation beats an open session — that ordering is task 24's security property and has adversarial tests). Bootstrap must not introduce a path that renders a zone before that check.
- `pnpm test`, the mobile lane, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1) — task 24 caught its own first rule run reporting `EXIT=0` while **4 tests failed**, because it read `tail`'s status through a pipe.

## Note — what is still owed after this, and cannot be closed here

Task 24 could not verify **anything** on a device or emulator: no Android toolchain, no dev server. Still owed to **27a/27b**: `eas build`, cold boot, the bootstrap report, CI stage 12, and the **enrollment E2E**. Also owed and **structurally unanswerable in this lane**: task 23's carried **banner-truncation measurement** — the test double reads *declared styles* and never measures frames, because there is no Yoga. Do not let a jsdom-shaped green stand in for a layout measurement (D12's lesson: an emulator/CI figure is not a device figure, and for *layout* even the emulator is the first honest witness).
