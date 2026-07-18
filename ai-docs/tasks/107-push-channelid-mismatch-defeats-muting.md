# TASK 107 — the push `channelId` the SERVER sends (`conflict`/`device`) does not match the Android channels the MOBILE app creates (`bolusi.conflict`/`bolusi.device`) — per-category muting is silently defeated

**Status:** todo
**Priority:** **MEDIUM** — a real per-category muting/routing bug on Android, but no LIVE impact in v0 (task 21's send triggers are un-wired seams; the registration endpoint is live but nothing sends yet). It bites the moment push goes live (tasks 16/17/20 wire the triggers). Needs a **spec decision** (one id scheme), not just a code edit. Overlaps task 59 (push muting → OS-settings deep-link).
**Depends on:** 21, 24
**Blocks:** — (must be resolved before push send goes live)
**SEC ids owned by THIS task:** none

## The finding (task 21, producer-traced by impl-21)

- The SERVER composes the push with `channelId: 'conflict' | 'device'` — per `api/04-push §4` ("channelId == category") and task 21's acceptance. (`apps/server/src/push/payload.ts`.)
- The MOBILE app (task 24) creates the Android notification channels as **`bolusi.conflict` / `bolusi.device`** (`apps/mobile/src/bootstrap/notifications.ts`).
- Android routes a delivered notification by exact `channelId`. A push carrying `channelId: 'conflict'` references a channel that **does not exist on the device** → Android drops it onto a default channel → the per-category importance + the user's **per-category mute** (the whole point of the notification-channel model, api/04 §3/§5) is silently bypassed. This is the CLAUDE.md §2.11 class: two authoritative sides that must agree, that nothing forces to agree, and that disagree.

impl-21 implemented per the spec (`channelId == category`) and FLAGGED the mismatch rather than paper over it — the right call. Task 24 created the `bolusi.<category>` channels before task 21 existed.

## The decision (pick ONE id scheme, ratify in the spec, then align both sides)

- **(a)** `api/04-push §4`'s `channelId` becomes `bolusi.<category>` (matching the shipped mobile channels) — the server composes `channelId: 'bolusi.' + category`. Smaller code change (server-side); keeps the mobile channels task 24 already ships.
- **(b)** the mobile channel ids become the bare category (`conflict`/`device`) — matches the current spec letter but re-IDs the shipped channels (a channel-id change can orphan a user's existing per-channel settings on upgrade — weigh it).
Recommend **(a)** (align the spec + server to the shipped `bolusi.<category>` channels; less churn, no on-device channel-id migration). Whatever is chosen, `api/04-push §4/§5` states the ONE scheme, and BOTH sides derive from it.

## Acceptance

- Ratify the id scheme in `api/04-push §4/§5` (one scheme, stated once).
- Align server (`payload.ts`) and mobile (`bootstrap/notifications.ts`) to derive the `channelId` from the SAME source (a shared constant/mapping if one can live in a package both import — else a cited, tested agreement).
- **Make the agreement ENFORCED (§2.11 — this is a comment/spec that nothing checks today):** a test that asserts every category the server can send has a matching created channel id on mobile (the same cross-file parity pattern task 25/77 used). **Falsify:** change one side's id → the parity test RED; restore → green. So this can never silently drift again.
- `pnpm typecheck`/`pnpm lint`/`pnpm test` green — read the output (§2.1).

## Note
Filed from task 21. Same shape as the notes-conflict parity (task 25) and the locale-list dedup (task 77): two hand-synced copies of one vocabulary with nothing forcing agreement. The muting model is a TRUST surface (a user who muted a category must stay muted); a channelId that lands on default silently un-mutes them — exactly the kind of silent failure the product must not have. Coordinate with task 59 (muting UX).
