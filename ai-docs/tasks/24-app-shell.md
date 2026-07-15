# TASK 24 — app-shell (Expo dev-build config, navigation, auth screens, sync status screen)

**Status:** todo
**Depends on:** 14, 22, 23

## Goal

Deliver `apps/mobile` (`@bolusi/mobile`) as a bootable Expo SDK 57 dev-client app: (1) the full native/dev-build configuration per 08 §2.2 — op-sqlite `package.json` block (`sqlcipher: true, performanceMode: true`), quick-crypto config plugin + nitro/base64 peers, expo-secure-store, expo-camera, expo-notifications (`android.googleServicesFile`), expo-location, expo-file-system, expo-background-task/task-manager, New Architecture on — plus `eas.json` with all four 08 §5.5 profiles (`test` carries `BOLUSI_TEST_HARNESS=1`); (2) app bootstrap in order: SQLCipher key from SecureStore → `@bolusi/db-client` open + local migrations → port wiring (quick-crypto `CryptoPort`, SecureStore `KeyStorePort`, `ClockPort`, non-blocking expo-location `LocationPort`, hc-typed `TransportPort` against type-only `@bolusi/server/client`) → module registration (auth from task 14; notes arrives in 25) → per-category notification channels (api/04-push §5) → sync trigger adapters (NetInfo, 3 s append debounce, 60 s foreground interval, background task, pull-to-refresh — api/01-sync §5) feeding core's `requestSync` intake behind an injected seam (task 15's loop; this task ships only the platform adapters); (3) the navigation shell per design-system §8.1 (AppShell header with SyncChip + Avatar, one banner slot, hardware-back = header back) with gating: unenrolled → Enrollment wizard, enrolled + no session / idle-locked → User Switcher, revoked → wizard with danger banner; (4) screens: 3-step Enrollment wizard (owner login per api/02-auth §4.2 → store confirm → done + first-PIN handoff, driving task 14's enrollment functions), User Switcher + PIN pad rendering 14's PinAuth states, Sync Status screen (staleness tiers, derived counters, manual sync, rejected + quarantined surfacing, media queue), and Settings (device locale id/en, per-category mute toggles, device info). All strings via `@bolusi/i18n` keys seeded from ui-labels.md; all components from `@bolusi/ui`. NOT in scope: the notes screens (25), the L6 Harness screen (26/27), push-token registration (21), the op-emitting `platform.setLocale` per-user preference (25 wires it; leave a seam).

## Docs to read

- `08-stack-and-repo.md` — §2.2 (every native dep, config plugin, and caveat — normative install list), §3.2 `@bolusi/mobile` row, §3.3 (mobile import edges incl. type-only server client), §5.2 (`no-hardcoded-strings`, boundaries), §5.5 (EAS profiles — reproduce verbatim), §6.2–6.4 (bootstrap sequence, seed users, emulator/LAN dev loop).
- `design-system.md` — §8.1–8.5 (AppShell, Switcher, PIN pad, Sync Status, Enrollment — the normative screen shapes), §5 (four mandatory states), §9 (review checklist this task is graded against).
- `api/02-auth.md` — §4.1–4.5 (enrollment flow, login/enroll DTOs + error legs, idempotency semantics, auth matrix), §6.1/§6.4–6.6 (PIN verify UX contract, idle lock + work preservation, lockout states the PIN pad renders, first-PIN/change/reset flows).
- `03-state-machines.md` — §8 (staleness levels + exported constants the Sync Status screen consumes), §10 (SyncState fields/guards the screen and manual-sync button reflect).
- `01-domain-model.md` — §5.2 only (SyncState field list; `pendingOperationCount`/`pendingMediaCount` are derived, never stored).
- `07-i18n.md` — §1.1–1.2 only (locale model; device-level pre-login locale — plain local storage, default `id`, `zh` not selectable).
- `api/04-push.md` — §3 + §5 only (v0 category set; channel-per-category muting via importance).
- `security-guide.md` — SEC-AUTH-08 row only.
- `ui-labels.md` — `auth.*`, `sync.*`, `core.settings.*`, `core.errors.*`, `core.rejection.*` sections (the keys these screens consume).

## Skills

- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- `frontend-design:frontend-design` — all screens; design-system §9 checklist is the gate.
- `superpowers:test-driven-development` — always.
- `superpowers:verification-before-completion` — the E2E enrollment run and device boot are observed outputs, not assumed.
- `superpowers:systematic-debugging` — on any red.

## Files / modules touched

- `apps/mobile/package.json` — deps via `npx expo install` (08 §2.1.3); op-sqlite config block. **A navigation library is NOT pinned in 08 §2.2 — adding one (proposed: `expo-router`, SDK-aligned) is a spec-table addition: stop and ask before install (CLAUDE.md §4/§6), record the pin in its own spec-change task.**
- `apps/mobile/app.config.ts` — New Architecture, config-plugin list per 08 §2.2, `googleServicesFile`, `EXPO_PUBLIC_API_URL`.
- `apps/mobile/eas.json` — the four 08 §5.5 profiles.
- `apps/mobile/src/bootstrap/` — `db.ts` (key → open → migrate), `ports/{crypto,keystore,clock,location,transport}.ts`, `modules.ts`, `notifications.ts` (channel creation), `sync-triggers.ts` (adapters → injected `requestSync` seam).
- `apps/mobile/src/navigation/` — root navigator + enrollment/session/lock gating.
- `apps/mobile/src/screens/{enrollment,switcher,pin,sync-status,settings}/` — the four surfaces.
- `apps/mobile/src/state/user-workspaces.ts` — per-user in-memory draft/nav state keyed by `userId` (SEC-AUTH-08).
- `apps/mobile/src/i18n.ts` — init from `@bolusi/i18n`, device-locale persistence.
- Colocated `*.test.ts(x)` per 08 §5.4.
- **NOT touched:** `packages/ui`, `packages/i18n`, `packages/core` (contended — CLAUDE.md §4). A missing component or label key is a coordinated change to the owning package/spec (ui-labels.md), never an inline edit or a hardcoded fallback.

## Acceptance

Observable done-condition:

- `pnpm lint`, `pnpm typecheck`, `pnpm test` green with `apps/mobile` in the build graph and all tests below present.
- `eas build --profile development --platform android` produces an installable dev client that cold-boots on the Android emulator (`http://10.0.2.2:3000`) AND a physical Android device (08 §6.4). Boot emits a dev-mode bootstrap report proving: SQLCipher DB opened with the SecureStore key, client migrations at head, quick-crypto smoke (argon2id + Ed25519 sign/verify + randomBytes) passed, notification channels created. Any config-plugin/native failure = not done. CI stage 12 (device lane, fingerprint-triggered) green.
- **Enrollment E2E against the local dev server** (`pnpm dev` + seed, 08 §6.2): fresh install → wizard step 1 login as seeded owner → step 2 shows tenant + store and requires confirmation before binding → step 3 done → switcher lists seeded users → first-PIN setup for a `pinVerifier: null` user → PIN unlock lands in the shell. Verified from ground truth, both sides: server has an `active` device row + `identity_audit` row; client has token + key seed in SecureStore, directory tables populated BEFORE any command, genesis op appended (seq 1, previousHash 64 zeros). Run recorded in the PR (script or transcript).

Tests to add (screen logic in vitest with injected fakes/fixtures; on-device manual passes recorded in the PR where automation can't reach):

- Enrollment wizard: happy path drives 14's enroll with a UUIDv7 `Idempotency-Key`; client-side schema blocks empty/short inputs with NO request fired; `401 AUTH_INVALID_CREDENTIALS` → one generic inline error (no user/password distinction in copy); `429 RATE_LIMITED` → inline countdown from `retryAfterSeconds`; non-owner credentials (`403`, permission-denial leg) → inline error, wizard state preserved; network failure after the enroll POST → retry reuses the SAME Idempotency-Key and completes via replay (idempotency); hardware/header back on non-empty input → ConfirmSheet; a `revoked` device lands here with the `danger` banner (§8.5).
- Switcher: only switcher-usable users render (deactivated never), sorted most-recently-active; all four mandatory states (empty → enrollment CTA; unauthorized renders error per §8.2); tap → PIN pad showing the selected user's identity.
- PIN pad renders 14's machine without re-implementing it: `delayed` → `auth.pin.wait` countdown and NO verify call while `now < notBefore`; `locked_out` → `auth.pin.lockedOut` + `auth.pin.forgot` affordance; wrong PIN → `auth.pin.attemptsLeft`; success → shell entry and 14's switch emission invoked exactly once (invalid-transition rendering asserted: no state maps to a blank screen).
- **SEC-AUTH-08 (owed by THIS task — the UI half, before review):** with a fake clock and bundle `idleLockSeconds`: timer fires → switcher-as-lock (no header back), 14's `session_ended(idle_lock)` requested; user A's draft state (keyed by `userId`) survives and is restored exactly on A's unlock; B unlocking sees B's/empty state, never A's; manual lock behaves identically with `manual_lock`. Same flow manually verified on the physical device; evidence in the PR. (SEC-AUTH-02/03/04/05/09, SEC-DEV-01/02/05/06 are owned by tasks 13/14/28 — this task renders their states, never duplicates their tests.)
- Sync Status screen against `SyncState` fixtures (01 §5.2 shapes; boundary ages computed from the EXPORTED 03 §8 constants, no numeric literals): never-synced → `stale` loud banner; fresh/warning/stale tier icon + banner both directions; counters read via derived queries (test proves no stored count column is read); manual sync invokes the trigger seam, `busy` while running, failure inline never modal, disabled with explanation when `syncDisabled='device_revoked'`; rejected list only when non-empty, per-row `core.rejection.<CODE>` label + tap → detail with `rejectionCode`/`rejectionReason`; quarantined ops surfaced loud via `sync.quarantine.*`; media queue rows per `uploadStatus` (progress %, failed → retry, uploaded drop off); header SyncChip maps all five states (`synced`/`pending`+count/`syncing`/`offline` neutral/`attention` on any rejected-or-revocation) from the same fixtures.
- Settings: locale toggle offers exactly `id`/`en` (`zh` absent), writes device locale (07-i18n §1.2) and re-renders immediately, pre-login surfaces use it after restart; the per-user `platform.setLocale` emission is asserted as an uncalled seam (scope guard — task 25 wires it); one mute toggle per api/04-push §3 category mapped to channel importance and persisted across restart; device info renders deviceId, deviceName, store + tenant, platform/appVersion from the enrollment persist.
- i18n: every label key referenced by these screens exists in BOTH `id` and `en` catalogs (key-existence test); 1.3× font scale + ID/EN length variance checked manually per design-system §9.

**Carried from the task 23 (ui-kit) review — two items whose real home is here:**
- **Banner truncation is a device check, and it MUST be measured, not eyeballed (task 23 review RISK).** The `@bolusi/ui` Banner is `numberOfLines={3}`, which truncates SILENTLY. The expanded `warning` string `sync.banner.warning` with `{relative}` filled — `"Terakhir terhubung 3 hari yang lalu. Data mungkin bukan yang terbaru."` (~69 chars) — at the 1.3× font scale design-system §6.5 requires MAY exceed 3 lines. The ui-kit test lane has no Yoga and CANNOT measure rendered line count — so this is provable only on the emulator/device, and only by reading actual rendered line count (via `onTextLayout`'s `nativeEvent.lines.length`, not by looking at a screenshot). Acceptance: on the emulator at 1.3× scale in BOTH id and en, assert every staleness Banner variant with its longest real `{relative}` expansion renders WITHOUT truncation (or the design changes — taller banner, shorter copy, or smaller scale). A silent truncation of the staleness message is a trust-surface failure: the one thing this product must never do is misrepresent how stale the data is, and a cut-off "Data mungkin bukan yang terbaru" is exactly that.
- **The "only list path" guarantee needs a lint rule (task 23 review MINOR → §2.11).** design-system §3.13 states as fact that screens never render a raw `FlatList`/`SectionList` or `.map()` rows — but nothing enforces it (grep of boundaries.js confirmed no such rule). Now that THIS task adds real screens, add the enforcing import-boundary rule: `react-native`'s `FlatList`/`SectionList`/`VirtualizedList` are importable only by `@bolusi/ui`; screens must use the `List` primitive. Falsify it: a screen importing `FlatList` directly must error. This converts §3.13 from a stated guarantee into an enforced one — the same claim-vs-code gap this session has closed five times over.

No CHAOS-* scenario is owed by this surface (harness = task 26); this task must keep them possible: the `test` profile's `BOLUSI_TEST_HARNESS=1` env plumbs through `app.config.ts` for 26/27's L6 screen.

Gates: `bolusi/no-hardcoded-strings` at `error` over `apps/mobile` with zero violations (the D4 checkbox hangs here); `bolusi/boundaries` unchanged and green (mobile edges per 08 §3.3, `@bolusi/server/client` type-only, op-sqlite reached only via `@bolusi/db-client`); `eas.json` matches 08 §5.5 verbatim; `google-services.json` never committed (EAS-held); `.env.example`/`app.config.ts` expose `EXPO_PUBLIC_API_URL`; pre-commit hooks pass without `--no-verify`; Conventional Commit subjects only.
