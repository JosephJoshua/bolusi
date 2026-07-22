# 00 — Product Overview (orientation doc)

> Produced by `brainstorm-prd` 2026-07-14. Orientation for every agent. Decisions live in `decisions/`; module detail lives in the PRDs; this doc is the map.

## What this is

**Bolusi** — offline-first ERP for a phone-repair franchise in West Papua, Indonesia. ~10 stores today, scaling to ~100. Becomes multi-tenant SaaS after V1 (no hard deadline — see decisions/2026-07-14).

## The one architectural idea

Nothing is stored as current state. Every business action is an **append-only, device-signed, hash-chained operation**; current state is a **projection** computed from the log; devices work fully offline and **sync operations** (not rows) to the cloud. The audit trail is not a feature — it is the storage. See ARCH-001 and PRD-012.

Why: unreliable 3G + days-long power outages make offline-first mandatory; the fraud model requires an unforgeable record of who did what.

## Users

8 roles (main owner → driver), mostly tech-inadept, on low-end Android (2GB RAM). UI: Bahasa Indonesia + EN toggle, large targets, minimal typing, PIN quick-switch on shared devices. Individual accounts always — attribution is what every fraud control rests on (PRD-011 §2).

## Build sequence

| Phase | Contents | Status |
| ----- | -------- | ------ |
| **v0 — Foundation proof** | Platform Core + Auth: op log, projections, sync, offline PIN auth, device enrollment, tenant isolation, conflict+staleness, media pipeline, i18n scaffold, push+realtime. Exit: chaos harness + reference module on a real 2GB Android — the on-device **runtime-verification target** (D12; **D21, 2026-07-22: the PERFORMANCE half of that clause is assumed-pass, device-unverified — v0 no longer waits on the physical lane for it, and nothing was measured; the correctness half still runs on the Android emulator, 27a**), not the whole platform story: iOS is a first-class target (D17/D18), config/prebuild + **CI-Simulator**-verified (unsigned `macos-latest` build+boot lane, D20 §2), with **signed/device builds owner-deferred** (D18 §5). | **current** |
| v1 — Money loop | Inventory, POS, Finance, Repair vertical, minimal owner dashboard | next brainstorm |
| v1.x | Delivery, HR attendance, GPS service, full reporting, chat | sequencing TBD |
| V2 | Agent mode (PRD-004) — V1 keeps the door open via pure commands, granular permissions, audit fields (ARCH-001 §9) | deferred |

## Explicitly OUT (do not build, do not drift)

- Agent mode features (LLM abstraction, rollback machinery, RAG, agent UI) — ARCH-001 §9.6
- Payroll — attendance only; scope decision pending (PRD-007 §9)
- Tax/e-Faktur/PPn — non-PKP stores; optional later (PRD-006 §11)
- Vouchers, store credit, loyalty points
- Voice input/messages
- Delivery of repaired phones (wholesale goods only)
- Facial recognition; behavioral analysis
- Custom BI / query builders

## Stack (decided 2026-07-14)

- **Client:** Expo React Native, targeting **Android and iOS**. **iOS is a first-class target** — an owner ruling (**D17**, 2026-07-16), with full parity required for all new work (**D18** §3, 2026-07-17); it reverses the earlier Android-first exclusivity, so do not re-derive "Android-first" from this doc. This **dev host** has **no iOS runtime** (Linux, no Xcode, no Simulator), so on *this* environment iOS is verified at the **config/prebuild-artifact level only**; **CI additionally runs an UNSIGNED iOS Simulator build+boot lane** on `macos-latest` (`expo prebuild` + `xcodebuild`, no Apple account — D20 §2, task 85), closing compile/link, does-it-launch, and generated-`Info.plist`/entitlements checks. **Signed iOS builds (EAS), Apple Developer enrollment, and physical-iPhone on-device verification stay owner-deferred** (D18 §5 / D20 §2 — no Simulator green is a device test). **Android is where on-device runtime verification happens** (emulator today; a physical 2GB unit is still owed — D12). Shared TS core packages (op log, sync, commands, projections). Desktop deferred (likely Tauri; open question).
- **Server:** Node LTS + Hono + PostgreSQL + **Kysely**. Zod schemas shared client↔server. pnpm workspaces monorepo.
- Verify current library docs before speccing/using any API — recommendations drift.

## Doc map

| Doc | Owns |
| --- | ---- |
| ARCH-001 | Architecture principles, constraints, cross-cutting patterns |
| PRD-001..012 | Module requirements (repair, inventory, finance, agent, reporting, POS, HR, delivery, GPS, chat, auth, platform core) |
| api/00-conventions | HTTP transport conventions: envelope, endpoint map, error codes, idempotency, realtime channel |
| api/01-sync | Push/pull sync protocol: batching, cursors, devices sidecar, sync triggers |
| api/02-auth | Identity control plane: bootstrap, enrollment, device bundle, offline PIN, devices/tokens, auth op registry |
| api/03-media | Media wire protocol: chunked resumable upload, integrity, immutability, download |
| api/04-push | Push notifications: token registration, categories, payload rules, device routing |
| decisions/ | Dated decision log — what, why, alternatives rejected |
| tasks/ | Task files + `_index.md` (canonical "what's left") |
