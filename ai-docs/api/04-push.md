# API 04 — Push Notifications

> **Owns:** the push surface — token registration (`POST /v1/push/tokens`), the v0 category set, payload composition rules, device-addressed routing, per-category muting, delivery expectations, Expo/FCM send mechanics, and token invalidation. Transport conventions (envelope, auth header, error codes) live in `api/00-conventions.md`; the realtime poke channel in api/00 §12; `push_tokens` DDL in `10-db-schema.md` §8; localized copy composition in `07-i18n.md` §8; the security checklist in `security-guide.md` §9.1.
> **Change control:** change this doc first, then the code. Wire changes are versioned via the `/v1/` path prefix.

## 1. Principles

- **Push is best-effort and never load-bearing.** Sync correctness never depends on a push arriving — the same rule as realtime (FR-1146; api/01-sync §8). A missed push costs latency or a missed heads-up, never data. No feature shall gate on push delivery.
- **Push is not a data plane.** Data always flows through authenticated pull. Push payloads carry a category, server-composed display text, and a deep-link route key with entity ids — **never business data values** (no names, amounts, note bodies, or payload contents). FCM payloads transit Google's infrastructure and land in the OS notification layer outside the app's encryption boundary (security-guide §9.1).
- **Pushes address devices, not users.** Shared-device reality: one Android device serves many staff via PIN switch, and the server cannot know who is holding the device at send time. Per-user targeting and per-user notification preferences (FR-1149) are **v1** (roadmap row).

## 2. Token registration — `POST /v1/push/tokens`

| | |
| - | - |
| Auth | device bearer (api/00 §3) |
| Request | `{ "expoPushToken": "ExponentPushToken[…]", "deviceId": "<uuid>" }` |
| Acting user | `X-Acting-User: <userId>` header (api/00 §3) when a session is active; **omitted otherwise** |
| Response | `200` `{ "deviceId": "<uuid>", "updatedAt": <ms epoch> }` |

- Semantics: **upsert keyed by `device_id`** — one token per device install (10-db-schema §8, `idx_push_tokens_device`). Registration overwrites the previous token and stamps `updated_at` with server time.
- **`push_tokens.user_id` is nullable.** Registration can happen before any PIN login — immediately post-enrollment, or at app start while the device sits on the switcher screen. The acting user travels in the `X-Acting-User` header: present when a session is active (server stamps `user_id` with it), omitted otherwise (server stamps `user_id = null`). The §4 locale rule falls back to `id-ID` while `user_id` is null; the next registration with an active session fills it in.
- `deviceId` must equal the bearer token's device; mismatch → `403 PERMISSION_DENIED`. `expoPushToken` must match the `ExponentPushToken[…]` shape; violations → `422 VALIDATION_FAILED`.
- **No `Idempotency-Key` header** — the upsert is idempotent by construction (replaying it converges on the same row), like the sync endpoints (api/00 §8.1); if sent, it is ignored.
- Client triggers: (a) every app start, call `getExpoPushTokenAsync({ projectId })` and POST when the token differs from the last-registered value (token rotation, security-guide §9.1); (b) immediately after enrollment completes; (c) after a `DeviceNotRegistered` invalidation (§8) the next app start re-registers naturally via (a).
- **Delete-on-revocation:** device revocation (api/02-auth §7.2) deletes the device's `push_tokens` row server-side, in the same transaction as the other revocation effects. There is no client-facing DELETE endpoint in v0.
- Rate limit (numbers owned here, per the api/00 §11 delegation): **30 token registrations per day per device**; excess → `429 RATE_LIMITED` with `Retry-After` (api/00 §11).

## 3. Categories (v0)

The closed v0 set. New categories are additive `/v1` changes (api/00 §4).

| `category` | Sent when | Recipients | Visible notification |
| ---------- | --------- | ---------- | -------------------- |
| `sync` | op(s) accepted within a device's pull scope and the device has no live realtime connection | every active device whose pull scope (api/01-sync §4.1) covers the accepted op | **No** — data-only wake |
| `conflict` | a Conflict transitions to `surfaced` (significant; 03-state-machines §7) | every active device of the conflict's store | Yes |
| `device` | device anomaly recorded (BAD_SIGNATURE / CHAIN_BROKEN / SCOPE_VIOLATION / CLOCK_SKEW — 10-db-schema `device_anomalies`) or a device is revoked | active devices whose registered user (§4) holds `auth.device_read` — owner devices | Yes |

Fan-out scope shall never exceed pull scope: a device must not learn, even via a wake, that another tenant or an out-of-scope store has activity (security-guide §9.1, SEC-RT-04 analog).

## 4. Payload rule

Every message carries `data: { "category": "...", "route": "...", "params": { … } }`. Notification categories (`conflict`, `device`) additionally carry `title` + `body` as **final display strings, composed server-side** — killed-app delivery renders whatever text the payload carries, so composition cannot be deferred to the client (07-i18n §8). `sync` is data-only: no `title`, no `body`, no route.

- **Localization:** the server renders title/body from the shared `@bolusi/i18n` catalog (`push.*` namespace, ui-labels) using the **target device's locale preference** — the `platform.user_locale` pref (user_prefs projection, 07-i18n §1.1) of the device's registered user (`push_tokens.user_id`, the user who last registered the token on that device). `user_id` null (pre-login registration, §2) or no pref synced yet → fallback **id-ID**. The server never inspects `Accept-Language` (07-i18n §9).
- **Content ceiling:** title/body are generic, localized sentences ("A conflict needs review", never "Budi edited note X"). `data.params` carries **entity ids only**. This is the normative payload rule; security-guide §9.1 states the same posture and its tests enforce it.
- **Deep-link route registry (v0):** `conflict` → `route: "conflicts"`, `params: { "conflictId": "<uuid>" }`; `device` → `route: "devices"`, `params: { "deviceId": "<uuid>" }`. Tapping the notification navigates to the route; the screen loads data from local projections — the push carried none.
- **`channelId` (the ONE scheme):** for a visible category, `channelId = "bolusi." + category` — so `conflict` → `"bolusi.conflict"`, `device` → `"bolusi.device"`. This is the single channel-id scheme both sides derive from: the server sets it here, the mobile app creates its Android channels under the SAME id (§5), and each derives it from the shared `pushChannelId` helper (`@bolusi/schemas`) so the two cannot drift. Android routes a delivered notification by EXACT `channelId`; a mismatch would land it on a default channel and silently defeat the user's per-category mute (§5), so the equality is enforced by a cross-side parity test. `sync` is data-only (§3) and carries **no** `channelId`.

## 5. Muting (v0: the in-app row opens the OS notification settings)

- Muting belongs to the **operating system**; the in-app control is **a row that opens the OS notification settings**, not a switch the app sets. This corrects an earlier model that set the channel's *importance* from the app (D18 §1; decisions/2026-07-17): **Android forbids an app changing a notification channel's importance after the channel is created** — importance belongs to the user, by design, so an app cannot un-mute itself — and **iOS has no per-category notification channels at all**. An app-set mute toggle is therefore either silently ignored (Android, post-creation) or has nothing to act on (iOS); the honest control hands the user to the OS screen that actually owns the setting.
- **The channels still exist, and that is the point.** One channel per VISIBLE category is created at app start (§3; 08-stack-and-repo §2.2) so the OS notification-settings screen shows **per-category** controls the user can mute — the `bolusi.conflict` and `bolusi.device` channels (the `channelId = "bolusi." + category` scheme of §4, created under the same id the server addresses) appear there as separate, individually-mutable channels. `sync` gets **no** channel (§3: data-only, no visible notification); a channel for it would surface a switch that silences nothing.
- **Android:** the row deep-links to the app's notification settings via the OS intent — `android.settings.CHANNEL_NOTIFICATION_SETTINGS` (a specific category channel, addressed by `EXTRA_APP_PACKAGE` + `EXTRA_CHANNEL_ID`), or the per-app notification screen. Per-category muting is **real** here, because the boot-created channels are what that screen lists.
- **iOS:** the row deep-links to the app's notification settings (`UIApplication.openNotificationSettingsURLString`, iOS 16+, or the app Settings page). iOS notification controls are **app-wide, not per-category** — there are no channels — so **v0 does not claim per-category muting on iOS**: the row opens the single app-level notification setting set, and that is the stated limit.
- The **server holds no mute state** and keeps sending in v0 (it has no preference store); suppression is entirely the OS's, applied to what the user set in the screen this row opens — and it still holds for **killed-app** delivery, because the OS, not the app, does the suppressing. `sync` muting never arises: it is data-only and shows nothing.
- This satisfies FR-1150 at device granularity — per-category on Android, app-wide on iOS; per-user preferences (FR-1149) remain v1 (roadmap).

## 6. Delivery expectations

- **Best-effort, at-most-once-ish, unordered.** Duplicates, drops, and multi-minute OEM delays are all in-contract. Every consumer of a push must work identically without it: `sync` merely triggers the same single-flight sync loop as a realtime poke (api/01-sync §6); `conflict` and `device` duplicate information that is already in projections after the next pull.
- The server sends `sync` pushes only to devices **without** a live WS/SSE connection (the realtime poke already covers connected devices) and coalesces per device: at most one `sync` push per device per 60 s.
- Push failures are logged, never surfaced as sync errors, and never block the push transaction — sending happens **after** commit, fire-and-forget from the request path.

## 7. Mechanics — Expo push service + FCM v1 (decisions D10)

- **Client:** `expo-notifications` (SDK-57 aligned, 08-stack-and-repo §2.2) — `getExpoPushTokenAsync({ projectId })` yields the `ExponentPushToken`. EAS **development builds are mandatory**: Expo Go cannot exercise Android push (D10).
- **Server:** the `@bolusi/server` push sender (08-stack-and-repo §3.2) POSTs messages to the Expo push HTTP API (`https://exp.host/--/api/v2/push/send`), batched ≤ 100 messages per request; Expo relays via **FCM HTTP v1**. Delivery receipts are fetched from `/--/api/v2/push/getReceipts` on a delayed schedule (≥ 15 min after send) and drive token invalidation (§8).
- **Credentials:** `google-services.json` wired via `android.googleServicesFile`; the FCM service-account key is uploaded to EAS credentials — never committed (security-guide §10; 08-stack-and-repo §5.5).
- v0 is Android-only in practice; `push_tokens.platform` defaults `'android'` (10-db-schema §8).

## 8. Error handling

| Signal | Server action |
| ------ | ------------- |
| `DeviceNotRegistered` in a push **ticket** or **receipt** | delete that `push_tokens` row immediately; the device re-registers on next app start (§2) |
| Other per-message errors (`MessageTooBig`, `InvalidCredentials`, …) | log with category + deviceId, drop the message; `InvalidCredentials` additionally alerts (config problem, not data) |
| Expo API request failure (network, 5xx, 429) | retry the batch with the standard backoff schedule (api/01-sync §6's 5 s → 15 s → 60 s → 5 min cap), bounded at 5 attempts, then drop |

Dropped pushes are never queued durably and never re-sent later — the next state change sends the next push, and pull remains the source of truth (§1).

## 9. What push is NOT

- **Not load-bearing** — no correctness, staleness, or security property may depend on it (§1, FR-1146).
- **Not a data plane** — entity ids only, ever (§4).
- **Not per-user** — targeting and preferences per user are v1 (roadmap); v0 addresses devices.
- **Not guaranteed, ordered, or unique** — consumers tolerate all three failures (§6).
