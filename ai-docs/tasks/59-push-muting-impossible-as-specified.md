# TASK 59 — `api/04-push §5`'s muting model **cannot work on Android**: channel importance is immutable to the app after creation, and the function that would change it has zero callers

**Status:** todo

> **OWNER RULING (2026-07-17):** Push muting RULED: deep-link to the OS per-channel/notification settings (both platforms). See D18. api/04-push §5 rewrite + delete applyChannelImportance. Buildable; depends on 21.

**Priority:** **HIGH — needs an owner decision before implementation** (see §The decision). The specified mechanism is not implementable on the target OS. A shop owner who mutes a category gets a toggle that cannot suppress anything.
**Depends on:** 21 (push wiring) — but the **decision** does not; make it first.
**Blocks:** the settings mute toggle (`04-push §5`, FR-1150)
**SEC ids owned by THIS task:** none

## Goal

Make per-category muting either **work on Android** or **stop being promised**, and fix `api/04-push §5`, whose stated mechanism the OS forbids.

## The finding

### 1. The spec's mechanism is impossible

`api/04-push.md §5`, verbatim:

> Each category maps 1:1 to an Android notification channel, created via `setNotificationChannelAsync` at app start… The in-app settings screen exposes a **boolean mute toggle per category, implemented as the channel's importance** — muting works even for killed-app delivery because the OS suppresses the channel, not the app.

Expo's current SDK docs, `setNotificationChannelAsync`, stated **twice**:

> **Note:** After a channel has been created, you can modify **only its name and description**. This limitation is imposed by the Android OS.

> Note that **only the name and description can be modified after creation** due to Android OS limitations.

`createNotificationChannels()` runs **at app start** (`bootstrap/notifications.ts:47`). So the channel exists from first boot onward, and from that moment **the app can never change its importance again**. The mute toggle's entire specified mechanism is available exactly once — before the user has ever seen the settings screen.

This is not an Expo limitation to route around. It is Android's deliberate design: **channel importance belongs to the user, not the app**, precisely so an app cannot un-mute itself. Anything that "fixes" this by fighting it is fighting the OS's intended behaviour.

### 2. The code says so, twelve lines above the code that violates it

`bootstrap/notifications.ts:4-6` — the file's own header:

> on Android a channel's importance **is fixed at creation and can afterwards only be changed by the USER in system settings**.

`bootstrap/notifications.ts:61-69` — in the same file:

```ts
/** Apply a mute toggle (api/04-push §5) — the Settings screen's `setChannelImportance` binding. */
export async function applyChannelImportance(
  category: MutablePushCategory,
  muted: boolean,
): Promise<void> {
  await Notifications.setNotificationChannelAsync(channelId(category), {
    name: t(categoryNameKey(category) as 'push.device.title'),
    importance: androidImportance(muted),   // ← ignored by Android on an existing channel
  });
}
```

**The author wrote down the exact constraint and then wrote a function that violates it.** The header is correct, sourced, and specific. It is also the reason nobody checked the function underneath it: a reader who reaches line 61 has already been told the rule at line 4 and reads `applyChannelImportance` as its implementation rather than its counterexample.

### 3. It has zero callers, so nothing could ever have noticed

`grep -rn "applyChannelImportance" apps/ packages/` → **one hit: its own definition.** The docstring calls it *"the Settings screen's `setChannelImportance` binding"*; the Settings screen does not bind it. So:

- the toggle is **unwired** — muting does nothing today for that reason;
- when someone wires it, muting will **still** do nothing, for the OS reason;
- and **no test, type, or lint can see either**, because an unwired export typechecks and `setNotificationChannelAsync` returns a resolved Promise whether or not Android honoured a single field.

The failure is silent in all three layers. `applyChannelImportance` resolves successfully, having changed nothing.

## The decision (make this FIRST — do not start coding)

Every option changes `api/04-push §5` or the settings UX. **This is a spec change and an owner-facing product decision** (CLAUDE.md §6 — the muting model is a core behaviour). Bring a recommendation; do not pick silently.

| option | works? | cost |
| ------ | ------ | ---- |
| **(a) Deep-link to Android's per-channel settings** — the in-app toggle becomes a row that opens the OS screen | **yes** — idiomatic; the user owns importance, which is Android's intent | the toggle stops being a toggle. Bounces a **tech-inadept, Indonesian-first** user into a system settings screen — Android's own copy, our locale only if the OS is set to `id`. Real UX cost for exactly our user. |
| **(b) Delete + recreate the channel on each mute change** | **no — verify before believing it** | Android **remembers deleted channel ids and restores their old settings on recreation**, specifically to defeat this. Recreating under a *new* id (`bolusi.device.v2`) evades it but leaks a growing list of stale channels into the user's settings screen — and `channelId()`'s own comment already warns *"a changed id is a NEW channel, defaults restored."* |
| **(c) Server-side suppression** | yes | **§5 explicitly rejected it** (*"the server keeps sending in v0; it holds no preference state"*) and it forfeits the property §5 is buying: killed-app suppression by the OS. Also v1 scope (FR-1149). |
| **(d) Ship the channels, drop the in-app toggle for v0** | n/a | honest and cheap; §5 and the settings screen both shrink. The channels still give the user *a* mute — in Android's settings, where Android puts it. |

**The orchestrator's recommendation: (a) or (d), and (d) if the settings screen is not already built.** Both respect the OS instead of fighting it; (b) is the option that looks like it works and is the one this repo is worst at — it would go green in every test we can run and fail on a real phone. Note the honest framing for (a)/(d): **v0 does not lose muting, it relocates it.** The channels created at boot are real and Android's own per-app settings already expose them per category — which is the thing `createNotificationChannels`'s design was buying all along (§5's *"create one channel for everything and the shop's only choice is all-or-nothing"*).

### The iOS dimension — added 2026-07-16 by task 80 under **D17**. NOT a resolution; a dimension the decision above was made without.

**Everything above this line is Android-reasoned and remains correct for Android.** D17 makes iOS a first-class target, so the owner should decide **once, with both platforms in view**, rather than twice.

**iOS has no notification channels, and the no-op is silent.** Traced to the producer, not the docs — `expo-notifications@57.0.3` ships `setNotificationChannelAsync.android.ts` (real, calls the native module) and `setNotificationChannelAsync.ts`, which is what Metro resolves on iOS because **no `.ios.ts` variant exists**:

```ts
/** @platform android */
export async function setNotificationChannelAsync(channelId, channel): Promise<NotificationChannel | null> {
  console.debug('Notification channels feature is only supported on Android.');
  return null;
}
```

There is no `Channel` source file anywhere in the package's `ios/` directory. So on iOS **the entire call resolves successfully having created nothing** — the same T-15 shape as this task's Android finding, one level wider: on Android the *field* is ignored, on iOS the *whole mechanism* is absent.

**Live consequence today (latent, not user-reachable — stated precisely, do not inflate):** `createNotificationChannels` (`bootstrap/notifications.ts:47`) is called at boot from `Root.tsx:88`. On iOS it loops the categories, awaits a call that returns `null`, and **`created.push(id)` unconditionally** — returning a list of channel ids that do not exist. It is not currently a user-facing bug: `Root.tsx:88` discards the return value, and `applyChannelImportance` still has **zero callers**. It becomes live the moment either the toggle is wired or that return value is trusted.

**The options table above does not survive the platform change — this is the part that needs the owner:**

| option | Android (as ruled above) | iOS |
| ------ | ------------------------ | --- |
| **(a)** deep-link to the OS per-channel screen | works; idiomatic | **no such screen exists.** `Linking.openSettings()` reaches the app's iOS settings page, whose controls are **per-app, not per-category** (`allowsAlert` / `allowsBadge` / `allowsSound` / `allowsDisplayOnLockScreen` — all app-wide). A row that opens an all-or-nothing switch is not per-category muting. |
| **(b)** delete + recreate the channel | defeated by Android by design | **n/a** — no channels. |
| **(c)** server-side suppression | rejected by §5 for v0; forfeits killed-app OS suppression | **the only option that delivers per-category muting on iOS at all**, and it works identically on both platforms. |
| **(d)** ship channels, drop the in-app toggle | honest — *"v0 does not lose muting, it relocates it"* | **that framing is Android-only and false here.** There is nowhere on iOS for it to relocate *to*. On iOS, (d) means per-category muting simply does not exist in v0. |

**The two platforms' idioms are opposite, which is the finding.** Android says importance belongs to the **user**, in the OS screen — so the app should get out of the way (options a/d). iOS's per-notification `InterruptionLevel` (`'passive' | 'active' | 'timeSensitive' | 'critical'`, `@platform ios`, on `NotificationContentIos`) is set by the **sender**, on the payload — and iOS's permission surface even carries `providesAppNotificationSettings`, the flag by which an app declares it hosts its **own** in-app notification settings for iOS to link to. **iOS expects the in-app toggle that Android's answer deletes.**

**So D17 shifts the calculus toward (c)** — the option §5 rejected and roadmap'd to v1 (FR-1149) — because it is the only mechanism under which one in-app toggle means the same thing on both platforms. That is a real cost (it forfeits killed-app OS suppression on Android, which is exactly what §5 was buying) and it is **not an agent's call**. **Do not resolve this here.** Note also that task 85's owner decision may rule v0 Android-only, which would collapse this back to the table above — **these two decisions should be made together, in that order.**

## Docs to read

- `api/04-push.md` **§5** (the claim to fix), §3 (the category table + the `sync`-gets-no-channel rule — preserve that reasoning, it is correct and well-argued), §6, §7 (Android-only in practice).
- `apps/mobile/src/bootstrap/notifications.ts` — the whole file. Its **header is right and its function is wrong**; keep the header.
- `apps/mobile/src/screens/settings/model.ts` — `MUTABLE_PUSH_CATEGORIES`, `channelImportance`, `PushMuteState`; whatever `PushMuteState` currently persists is only meaningful under option (c).
- **Expo `expo-notifications` docs via Context7 — read them yourself, do not trust this file's quotes** (§2.1). Specifically `setNotificationChannelAsync`'s post-creation note and `deleteNotificationChannelAsync`. **If Android/Expo has changed this, the premise moved — stop and report.**
- `testing-guide.md` T-11, T-12, **T-14f** (*typed and compiling ≠ running on the target platform* — this task and 58 are the same class).
- `ai-docs/tasks/58-*.md` — **the sibling.** Same file class, same shape, same root cause; read its Note before writing yours.
- `CLAUDE.md` §2.11, §6 (red flags — a spec-behaviour change stops and asks).

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- **No physical Android** (D12/D13). You **cannot** verify on-device that a mute suppresses a real FCM push. Say so; see the honesty clause.

## Acceptance

**Observable done-condition:** `api/04-push §5` describes a mechanism that the Android OS permits, the code matches it, and no exported function claims a binding that does not exist.

- **Doc-first** (§4: *"do not edit spec content as a side effect of implementation — spec changes are their own task"* — for this task, the spec change **is** the task). `api/04-push §5` changes before any code. Record the ruling in `decisions/` with the Expo/Android citation, because the next agent will otherwise re-derive `importance:` as the obvious implementation — it is obvious, it is what the spec says, and it does not work.
- **Reproduce the premise, don't take it from this file** (T-11): confirm from Expo's live docs that importance is immutable post-creation. If you can drive an emulator, show `getNotificationChannelAsync` returning the **unchanged** importance after `applyChannelImportance` — that is the reproduction. If you cannot, say the premise rests on the docs alone and name that as the residual risk.
- **Kill or wire `applyChannelImportance`.** It must not survive this task as an uncalled export with a docstring naming a binding that doesn't exist. Under (a)/(d) it is **deleted**. Under any option, **the function that resolves successfully while changing nothing does not stay in the tree.**
- **THE GUARD** (§2.11/T-14): whatever ships, the failure this task fixes must become **loud**. The class is *"a resolved Promise that changed nothing."* Options: a test asserting `getNotificationChannelAsync` reflects what was set (the real oracle, needs an emulator), or — reachable without a device — a test asserting **no production code passes `importance` to `setNotificationChannelAsync` for an already-created channel**, so the pattern cannot come back. **Falsify it**: reintroduce the call → red; remove → green. Report the falsification.
- **Test `createNotificationChannels` while you are here** (review-05: the file has **0 tests**). `vi.mock('expo-notifications')` — no device needed. The highest-consequence assertion, in review-05's words *"Android keeps whatever name it is first given"* → **permanent for that install**: a channel created before `bootstrapI18n` resolves is named in the wrong language **forever**, in Android's own settings screen, where no in-app re-render can ever reach it. Assert: **(1)** `sync` gets no channel (§3 — the reasoning at `notifications.ts:10-12` is deliberate and worth pinning); **(2)** one channel per `MUTABLE_PUSH_CATEGORIES` entry, ids stable; **(3)** `name` is a resolved catalog string, not a key — a channel named `push.device.title` is permanent and user-visible.
- **Check the boot ORDER, and treat it as this task's second finding if it is wrong.** `createNotificationChannels` calls `t(...)` at line 52. If it can run before `bootstrapI18n` (`i18n.ts` — also **0 tests**, review-05), the channel name is permanently the fallback locale. **`t()` at module-init time is the bug; the channel name is just where it becomes irreversible.** Report the ordering you find, with the file:line that establishes it.
- **Sweep the class** (T-12): what other **Android-side write** in `apps/mobile` resolves successfully while the OS ignores it? This is task 58's class from the other end — 58 is a *config* the OS never reads, this is an *API call* the OS partly ignores. Report; don't fix here.
- **Honesty clause** (D12/D13): you cannot demo a muted push not arriving. The residual risk — *"the mechanism is doc-verified and emulator-verified at most; suppression of a real FCM push on a real device is unverified"* — goes in the Outcome **in those words**.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Third instance of one shape in a single sweep (with task 58 and the `canAttempt` finding), and the sharpest: **the comment was the guard, and here the comment is *correct*.**

`notifications.ts:4-6` states Android's rule accurately, cites the spec, and explains the consequence. `applyChannelImportance` at line 61 breaks that exact rule. The two are **twelve lines apart, in one file, written by one author, in one sitting.** No reviewer caught it. The reason is worth naming: a header that authoritative doesn't just fail to prevent the bug below it — it **actively supplies the reader's confidence**. You read line 4, you learn the constraint, and by line 61 you are no longer checking against it; you are reading `applyChannelImportance` *as* the thing line 4 described. The comment didn't miss the bug. **The comment is why the bug was invisible.**

And nothing else could have caught it. `setNotificationChannelAsync` returns a Promise that resolves whether or not Android honoured `importance`. There is no exit code, no exception, no type error, no lint. The function **succeeds at doing nothing** — which is CLAUDE.md §2.11's exact definition of the worst failure mode (*"a guard whose failure mode is 'silently checks nothing'"*), arriving in a new place: not a gate, not a type, but **a production write to the OS**.

The generalisation for `testing-guide` (see the T-15 proposal accompanying this task): **this repo's failures are no longer only "a test that checks nothing" — they are "a call that changes nothing."** Both are green. Both are silent. Both are found only by asking review-05's question — *"if this were wrong, what would notice?"* — and both answer **nothing**.
