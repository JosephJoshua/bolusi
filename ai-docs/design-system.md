# Design System — v0

> **Owns:** the v0 design language: tokens (color, type, spacing, touch), typography, the v0 component inventory and each component's mandatory states, the mandatory screen-state rule (loading/empty/error/unauthorized), offline-first UI rules (optimistic actions, pending/rejected chips, staleness banners), the accessibility floor, RN implementation constraints, and screen-shell conventions for the v0 surfaces. State-machine definitions live in `03-state-machines.md`; staleness levels and their numeric thresholds in `03-state-machines.md` §8; label-catalog mechanics in `07-i18n.md`; op semantics in `05-operation-log.md`.
> **Change control:** change this doc first, then the code. Token values and component state contracts are load-bearing for every screen review; ad-hoc styles or new component variants without a doc change fail review.

## 0. Constraints that drive everything

| Constraint (ARCH-001 §1) | Design consequence |
| --- | --- |
| 2GB-RAM / 32GB Android, low-end GPU | No styling library, no animation library, no custom fonts, no shadows-as-decoration, fixed-height list rows (§7) |
| Small screens, low brightness, used in bright shops | Light theme only in v0, high-contrast palette (all text ≥ 4.5:1), large type (body 18) |
| Tech-inadept users (cashier/technician "very low" skill) | One primary action per screen, no jargon, no icons without labels, forgiving flows, minimal typing |
| One-handed use at a counter | Primary action bottom-anchored in thumb zone; destructive never adjacent to primary |
| Shared device, PIN quick-switch (PRD-011 §2) | User switcher + PIN pad are first-class shell surfaces (§8) |
| Indonesian-first, EN toggle | Zero hardcoded strings (FR-1158); layouts tolerate +30% text expansion; buttons wrap, never truncate |
| Offline-first (NFR-1102) | Local actions NEVER show network affordances; network state is ambient, not blocking (§4) |

## 1. Design tokens

Tokens are the ONLY styling vocabulary. Components and screens shall consume tokens; raw hex/px literals in component or screen code fail review (lint rule, see §7). Tokens live in `packages/ui` (`@bolusi/ui`), file `tokens.ts`, plain frozen objects.

### 1.1 Color — semantic tokens (light theme)

**Dark mode is explicitly deferred** (out of v0 — keeps v0 small; bright-shop usage makes light the priority). The semantic-token indirection is the dark-mode enabler: a future dark theme is a second token map, zero component changes. Never bypass it.

| Token | Value | Usage |
| --- | --- | --- |
| `color.primary` | `#1D4ED8` | Primary buttons, active states, links. 6.3:1 on white. |
| `color.primaryPressed` | `#1E40AF` | Pressed/active fill of primary surfaces. |
| `color.onPrimary` | `#FFFFFF` | Text/icons on `primary`. |
| `color.success` | `#15803D` | Success text/icons (uploaded, synced confirmations). 5.0:1 on white. |
| `color.successBg` | `#DCFCE7` | Success tint surfaces. Pair text `#166534`. |
| `color.warning` | `#92400E` | Warning TEXT/icons (7.3:1 on white). Never white-on-amber (fails contrast). |
| `color.warningBg` | `#FEF3C7` | Warning banner/chip background. Pair text `color.warning`. |
| `color.danger` | `#B91C1C` | Destructive buttons, rejected ops, error text. 6.4:1 on white. |
| `color.dangerPressed` | `#991B1B` | Pressed destructive fill. |
| `color.dangerBg` | `#FEE2E2` | Danger banner/chip background. Pair text `#991B1B`. |
| `color.onDanger` | `#FFFFFF` | Text on `danger`. |
| `color.info` | `#1E40AF` | Info banner text/icons. |
| `color.infoBg` | `#DBEAFE` | Info banner background. |
| `color.surface` | `#FFFFFF` | Default screen/card background. |
| `color.surfaceAlt` | `#F4F4F5` | Secondary background: skeletons, pressed rows, chips, input fill. |
| `color.border` | `#D4D4D8` | Hairline borders, dividers, input outlines. |
| `color.text` | `#18181B` | Default text. ~17:1 on white. |
| `color.textMuted` | `#52525B` | Secondary text, timestamps, meta. 7.6:1 on white. |
| `color.textDisabled` | `#A1A1AA` | Disabled labels only (exempt from contrast floor per WCAG). |
| `color.overlay` | `#18181B` @ 40% | Scrim behind ConfirmSheet only. |

Rules:

- The palette is CLOSED. New colors require a change to this doc first.
- `warning` is never a filled-button color (white-on-amber fails 4.5:1); warnings render as tinted banners/chips with dark text.
- Semantic meaning is fixed: primary = act, success = completed/confirmed, warning = degraded/attention, danger = destructive/failed/rejected. Never repurpose (e.g. no "danger" for emphasis).

### 1.5 Identity hues (Avatar only)

> **Added 2026-07-15 (task 23)** for §3.12.

A CLOSED 8-hue ramp used **only** by `Avatar` to give each user a stable colour: `#0C4A6E` `#14532D` `#581C87` `#7C2D12` `#831843` `#115E59` `#713F12` `#3F3F46`, all carrying `color.onIdentity` (`#FFFFFF`).

This is an **identity** ramp, not a semantic one, and the distinction is load-bearing:

- These hues carry **no status meaning** and never signal state, so §1.1's "never repurpose" and §6.3's "no colour-only signalling" are untouched — initials are text; the hue only accelerates recognition.
- Every hue clears 4.5:1 against `onIdentity`, asserted mechanically in `tokens.test.ts`, so no user can be dealt an unreadable disc.
- All are **dark and saturated**: on a dimmed low-cost LCD in equatorial sun (§0), light tints wash out to the same pale smudge and stop being distinguishable from each other — which would defeat the entire point.
- **None is red or `color.primary`**: red is `danger` and blue is "act". A person must not read as an error or a button.

### 1.2 Type scale

Base is deliberately LARGE (body 18) — small screens, low brightness, low-vision-tolerant users. Nothing below 14.

| Token | Size/line (dp) | Weight | Usage |
| --- | --- | --- | --- |
| `type.display` | 32/40 | 700 | Big numbers (IDR totals, counts on Sync Status). `fontVariant: ['tabular-nums']` for numerics. |
| `type.title` | 24/32 | 700 | Screen titles. |
| `type.heading` | 20/28 | 600 | Section headers, card titles. |
| `type.body` | 18/26 | 400 | DEFAULT body text, list-row primary text, input text. |
| `type.bodyBold` | 18/26 | 600 | Button labels, emphasized values. |
| `type.bodySm` | 16/24 | 400 | Secondary row text, banner body, hints. |
| `type.caption` | 14/20 | 400 | Chips, timestamps, meta. FLOOR — nothing smaller ships. |

All text styles must respect the OS font-scale setting (`allowFontScaling` stays default-on); layouts shall survive 1.3× scale without clipping (test gate, §9).

### 1.3 Spacing, radius, borders

4-dp base grid. Scale is CLOSED — no in-between values.

| Token | dp | | Token | dp |
| --- | --- | --- | --- | --- |
| `space.xs` | 4 | | `space.xl` | 24 |
| `space.sm` | 8 | | `space.2xl` | 32 |
| `space.md` | 12 | | `space.3xl` | 48 |
| `space.lg` | 16 (default screen padding) | | | |

| Token | Value | Usage |
| --- | --- | --- |
| `radius.sm` | 8 | Chips, inputs |
| `radius.md` | 12 | Buttons, cards, banners |
| `radius.full` | 999 | Avatars, PIN dots |
| `border.hairline` | 1 | Dividers, card/input outlines |
| `border.focus` | 2 | Focus/active input outline (`color.primary`) |

No elevation/shadow tokens in v0: depth is expressed with `border.hairline` + `surfaceAlt` (shadows cost GPU overdraw on low-end devices). Single exception: ConfirmSheet uses `color.overlay` scrim.

### 1.4 Touch targets

| Token | dp | Applies to |
| --- | --- | --- |
| `touch.min` | 48 × 48 | EVERY interactive element — hard floor, no exceptions |
| `touch.primary` | 56 (height) | Primary/destructive buttons, bottom action bar |
| `touch.key` | 64 × 64 | PIN pad keys, numeric keypads |
| `touch.row` | 56 min / 64 default | List rows |
| `touch.gap` | 8 | Minimum spacing between adjacent targets |

A visual element may be smaller than 48 dp only if its pressable hit area (via `hitSlop`) still meets `touch.min`.

## 2. Typography — system font stack only

v0 ships **no custom font**. `fontFamily` is never set; Android renders Roboto/system, iOS renders SF.

Justification (normative, do not relitigate per-screen):

1. A custom font family (4 weights) adds ~300–600 KB to the bundle and per-glyph rasterization cost on 2GB devices — measurable cold-start and memory cost against NFR-1103.
2. System fonts have complete Latin coverage; Bahasa Indonesia needs nothing exotic.
3. System fonts inherit OS-level font scaling and rendering optimizations for low-DPI screens.

Weights used: 400/600/700 only. Numeric UI (money, counts) sets `fontVariant: ['tabular-nums']`. Money renders per `07-i18n.md` locale rules (integer IDR, `Rp 250.000`, never minor units — FR-1160); the design system provides the text style, i18n owns the formatting.

## 3. Component inventory — v0

The complete v0 set. Screens compose ONLY these (+ raw `View`/`Text` with tokens). A new component = a change to this doc first.

`Button · TextInput · PinPad · List · ListRow · Card · Chip · Banner · Toast · EmptyState · LoadingState (Skeleton/Spinner) · ConfirmSheet · FreshnessCell · Avatar · AppShell (header + banner slot + bottom action bar)`

All user-visible strings on every component arrive as already-localized strings resolved from the label catalog by the screen (`07-i18n.md`); components never contain literals.

### 3.1 Button

| Variant | Fill / text | Use |
| --- | --- | --- |
| `primary` | `color.primary` / `onPrimary` | THE action of the screen. Max one visible per screen. |
| `secondary` | `surface` + `border.hairline` outline / `color.primary` text | Alternate/back actions. |
| `destructive` | `color.danger` / `onDanger` | Irreversible-feeling actions (archive, revoke, deactivate). Never adjacent to `primary` (min `space.xl` separation or separate row). |

States (all variants, all mandatory): `default`, `pressed` (fill → pressed token; secondary → `surfaceAlt`), `disabled` (`surfaceAlt` fill, `textDisabled` label, still announces disabled to accessibility), `busy` (inline spinner replaces label, button stays width-stable, disabled while busy). `busy` is for **local** work only — a button must never spin waiting for the network (§4).

Height `touch.primary` (56), radius `radius.md`, label `type.bodyBold`, full-width in bottom action bars. Labels wrap to 2 lines rather than truncate (ID/EN length variance).

### 3.2 TextInput

Filled style: `surfaceAlt` background, `border.hairline` outline, `radius.sm`, text `type.body`, min height 56. States: `default`, `focused` (`border.focus` in `color.primary`), `error` (`color.danger` outline + `type.bodySm` error text below in `color.danger` + error icon — never color-only, §6), `disabled`.

Rules: label always visible ABOVE the field (never placeholder-as-label — it vanishes on input, fatal for tech-inadept users). Placeholder = example content only, `textMuted`. Numeric fields open numeric keyboards (`keyboardType`). Minimize typing: prefer pickers/steppers/defaults wherever the domain allows.

### 3.3 PinPad

Dedicated component; the system keyboard is NEVER used for PINs.

- 3×4 grid: digits 1–9, blank, 0, backspace. Keys `touch.key` (64), `type.title` digits.
- Fixed key layout (no shuffling — memory-of-place is how tech-inadept users cope).
- Entry shown as 6 dots (`radius.full`) — the v0 PIN is 6 digits, fixed (`api/02-auth.md` §6.1) — filled as typed. Digits are never echoed.
- `error` state: dots and message flash `color.danger` + message slot (`type.bodySm`), entry cleared, vibration (`expo-haptics`-free: use `Vibration.vibrate`, no new dep).
- `locked` state (rate-limit escalation, FR-1011): keys disabled, countdown message shown from the label catalog. Lockout logic is owned by `api/02-auth.md`; PinPad only renders it.
- Auto-submits on 6th digit — no confirm button.

### 3.4 ListRow / Card

**ListRow** (default collection surface): fixed height `touch.row` (64), leading slot (icon/avatar 40), primary text `type.body` (1 line, ellipsize tail), secondary text `type.bodySm` `textMuted` (1 line), trailing slot (Chip and/or chevron), `border.hairline` bottom divider. Pressed = `surfaceAlt`. Fixed height is a performance contract, not a style choice (§7, `getItemLayout`).

**Card** (dashboard/detail grouping): `surface`, `radius.md`, `border.hairline`, padding `space.lg`. No shadow. Cards are static or fully tappable — never mixed tap zones inside one card except an explicit trailing button meeting `touch.min`.

### 3.5 Chip — including op syncStatus conventions

Chip: height 28 (hit area padded to `touch.min` when tappable), `radius.sm`, `type.caption`, icon + label — icon mandatory (no color-only signaling, §6).

**Sync-status chips are the canonical pending-marker of the whole app.** Every list row / detail header whose entity has ops not yet `synced` shows one (states from `03-state-machines.md` §Operation.syncStatus):

| Op state | Chip | Visual |
| --- | --- | --- |
| all ops `synced` | **none** | Synced is the silent default — a checkmark on everything is noise. |
| any op `local` | pending chip | `surfaceAlt` bg, `textMuted` text, clock icon, label key `sync.chip.pending`. Informational, not alarming: the action ALREADY succeeded locally (§4). |
| any op `rejected` | rejected chip | `dangerBg` bg, `danger` text, alert icon, label key `sync.chip.rejected`. ALWAYS tappable → rejected-op detail on the Sync Status screen (§8.4). Never silent (05-operation-log §8). |

Precedence when both apply: `rejected` wins. Chips derive from the ops' bookkeeping fields; screens never compute their own sync heuristics.

### 3.6 Banner — the staleness / conflict / error surface

The Banner is the ONE ambient escalation surface, rendered in the AppShell banner slot (below header, above content, full-width, `radius` 0). Three variants:

| Variant | Bg / text | Dismiss | Used for |
| --- | --- | --- | --- |
| `info` | `infoBg` / `info` | dismissible (session) | Background completions worth ambient note (e.g. large backfill pull finished) |
| `warning` | `warningBg` / `warning` | collapsible to header dot, re-expands next screen | Staleness level `warning`; `Conflict.surfaced` awaiting decision |
| `danger` | `dangerBg` / `#991B1B` | NOT dismissible while cause persists | Staleness level `stale`; any `rejected` op; `Device.revoked`; `User.deactivated` |

Anatomy: leading glyph (mandatory — the §3.11 FreshnessCell for staleness causes, otherwise the variant icon) + message (`type.bodySm`, **max 3 lines**) + optional single action button (secondary-style, min `touch.min`). Message + action labels from the label catalog.

> **Changed 2026-07-15 (task 23): 2 lines → 3.** Evidence, not preference: the real catalog string `sync.banner.stale` in Indonesian is *"Sudah lama tidak terhubung. Data di layar ini bisa jauh tertinggal."* (67 chars), which already fills two `bodySm` lines on a 360 dp screen and **overflows them at the 1.3× font scale §6.5 requires us to survive**. Two lines would truncate the sentence telling a technician their data is stale — the one thing this product promises never to hide. Indonesian runs longer than English here (`Belum terkirim` vs `Not sent yet`; `mendaftarkannya` is a single 15-char word), so banner copy must be sized against the ID catalog, never against English.

**Staleness escalation** — levels and their numeric thresholds are owned by `03-state-machines.md` §8; the numbers live ONLY there and are never restated here. The Banner mapping is:

| Staleness level (`03-state-machines.md` §8) | Banner |
| --- | --- |
| `fresh` | No banner. Header sync chip only (§8.1) — quiet is a feature. |
| `warning` | `warning` banner: last-sync time + action → Sync Status screen. |
| `stale` | `danger` banner: loud, persistent, not dismissible; action → Sync Status screen. |

**Conflict surfacing** (`03-state-machines.md` §Conflict): `detected → auto_resolved` shows nothing (by design — nothing to decide). `surfaced` shows a `warning` banner to users who can act on it, action → conflict review; on `acknowledged` (store-owner decision recorded as a new operation) the banner clears.

**Priority stacking** — exactly ONE banner visible; highest wins; if others are suppressed, the visible banner appends "+N" and tapping it opens the Sync Status screen (which lists everything):

1. `danger` security (device revoked / user deactivated)
2. `danger` rejected ops
3. `danger` staleness (level `stale`)
4. `warning` conflict surfaced
5. `warning` staleness (level `warning`)
6. `info`

### 3.7 Toast vs inline errors (policy)

**Prefer inline. Toasts are for background events only.**

| Situation | Surface |
| --- | --- |
| Validation / command `DomainError` from the user's current action | Inline: TextInput `error` state or error text adjacent to the control that caused it. NEVER a toast — toasts vanish before slow readers finish. |
| Background event completing/failing (media upload finished, backfill pull done) | Toast allowed: bottom-anchored above action bar, `surface` bg + `border.hairline`, icon + `type.bodySm`, auto-hide 4 s, max one at a time. |
| Anything requiring user action or acknowledgment | NEVER a toast alone. Banner, chip, or screen state — a toast may additionally announce it, but a persistent surface must exist. |
| Op rejection | Banner + chip (§3.5/3.6). Toast optional as announcement, never the only surface. |

Toasts never contain buttons other than an optional single "view" action; they are never stacked; they never block touch.

### 3.8 EmptyState

Centered in the content area: icon (48, `textMuted`) + title (`type.heading`, 1 line) + hint (`type.bodySm` `textMuted`, ≤ 2 lines) + optional primary Button when the user holds the create permission. Empty ≠ error ≠ unauthorized — three distinct components, never substituted (§5, FR-1036).

### 3.9 LoadingState — skeleton vs spinner policy

| Case | Treatment |
| --- | --- |
| Local projection query (the normal case) | Render nothing for the first 300 ms (queries usually resolve in ms; avoid flash), then loading treatment. A local query still loading at 1 s is a defect, not a UX case — file it. |
| Lists | **Skeleton**: 6 fixed-height ghost rows (`surfaceAlt` blocks matching ListRow geometry), no shimmer animation (GPU cost; static is fine). |
| Non-list content (detail, totals) | **Spinner** (`ActivityIndicator`, `color.primary`) only when expected < 1 s; otherwise skeleton blocks matching final layout. |
| Layout stability | Loading treatment must occupy the same geometry as loaded content — no layout jump on resolve. |
| Network | NEVER a loading state for a local action; network progress belongs to the sync chip / Sync Status screen only (§4). |

### 3.10 Modal policy — avoid; full-screen flows preferred

Dialog/popup modals are effectively BANNED in v0. Multi-step or form-bearing interactions are **full-screen flows** (wizard pattern per PRD-012 guided-flow direction): one decision per screen, back always available, progress text ("2/3") in the header, primary action bottom-anchored.

Single sanctioned exception — **ConfirmSheet**: a bottom sheet for one-tap confirmation of destructive actions (archive note, revoke device, deactivate user). Anatomy: `overlay` scrim, `surface` sheet (`radius.md` top corners), title + ≤ 2-line consequence text + destructive Button + secondary cancel Button (cancel on the bottom, safest position for thumb misfires). No forms inside sheets, no nesting, no stacking. Anything bigger becomes a full-screen flow.

Rationale: modals trap tech-inadept users (unclear dismissal), break Android back-button expectations, and float small touch targets.

### 3.11 FreshnessCell — the staleness-tier instrument (**signature element**)

> **Added 2026-07-15 (task 23).** §8.4 already required a "staleness-tier icon" without specifying one. This section specifies it, and promotes it to the design system's signature element.

A **battery cell** whose FILL encodes the staleness tier. Three discrete states, driven by the level name from `03-state-machines.md` §8 — never an age, never a percentage (a continuous fill would require the thresholds, and §8 is their sole home).

| Level (`03-state-machines.md` §8) | Cell | Tint |
| --- | --- | --- |
| `fresh` | full | `textMuted` — quiet |
| `warning` | half | `warning` |
| `stale` | **empty** | `danger` |

Rationale (normative — do not relitigate per-screen):

1. **The domain's own instrument.** This is a phone-repair counter; a charge level is the most-read glyph in the building. It is legible pre-literately, in any language — which §0 requires ("tech-inadept", literacy sometimes limited), and which a grey timestamp chip is not.
2. **Fill, not hue, is the signal.** On a dimmed low-cost LCD in equatorial sun (§0) hue washes out and mid-greys crush; a fill fraction is a shape, and shape survives. Colour only reinforces — so the cell is colourblind-safe and satisfies §6.3 by construction.
3. **It is literally true of the system.** Local data holds a charge that drains while offline and recharges on sync. The metaphor does not have to be taught.
4. **Never animates.** Static costs no GPU on the 2 GB target (§7), and leaves `prefers-reduced-motion` nothing to honour here.

Placement: the §3.6 Banner's leading glyph for staleness causes, and the §8.4 status header. Using the same object in both is the point — the escalation reads as ONE instrument getting worse, not three unrelated coloured strips. Drawn with `View`s; no SVG, no new dependency.

### 3.12 Avatar — identity, recognised rather than read

> **Added 2026-07-15 (task 23).** §8.2 said "initials on `surfaceAlt`"; that made every user an identical grey disc, which defeats the purpose PRD-011 §6.1 states.

PRD-011 §6.1: these users identify themselves by **face**, far faster than by reading a name — "a wall of names in an unfamiliar script, for an employee whose literacy may be limited, is a barrier where a face is not." v0 ships no photo-upload UI (roadmap), though the directory carries `photoMediaId` from day one. So the initials fallback must be **good, not an apology**:

- **A stable, distinct hue per user**, derived deterministically from `userId` (not the name — renaming must not repaint a person, and two users with the same initials must still differ). This makes identity a two-channel object (colour + letterform), recognisable in peripheral vision without reading — the whole job of §8.2, whose budget is ≤ 5 s (NFR-1003).
- Initials are text, so colour is never the only signal (§6.3); the hue is an accelerator, not the information.
- Hues come from the CLOSED `identityPalette` (§1.5), every member contrast-validated against white.
- Sizes: `row` 40 (§3.4 leading slot), `header` 48 (§8.1), `switcher` **96** (§8.2 — big enough to be a face, not a bullet point).
- A photo slots into the same geometry later with zero layout change.

### 3.13 List — the only collection primitive

> **Added 2026-07-15 (task 23).** §7 specified the FlatList CONFIG but named no component, leaving each screen to wire (or forget) it.

Screens render collections through `List` and not a raw `FlatList` / `.map()` — a **convention until enforced by task 24's screen import-boundary lint rule** (no screens exist yet to scope such a rule against, so it lands with them). `List` owns two things structurally:

1. **Virtualization**, so it is not a per-screen decision. A `.map()` over a year of history (`testing-guide` §4.1 `SEED-200K`) dies on the 2 GB target. Owning the primitive means the windowing config is written once — and the engine becomes a one-file swap rather than a 25-screen rewrite.
2. **The four §5 states as a discriminated union** (`loading | empty | error | unauthorized | ready`). This makes the states first-class and prevents the classic "render `[]` that reads as empty when the truth is denied" bug (FR-1036): a screen cannot render items-or-empty while meaning `unauthorized`, nor pass a partial state, without a compile error. It does **not** force an auth-unaware screen to grow an auth branch — a screen that only passes `ready`/`empty` compiles; making denial reach `List` is the screen's job, enforced screen-side by task 24's exhaustive-mapping pattern.

Row height is `touch.row`, uniform — that is what makes `getItemLayout` legal, so §3.4's fixed row height and this component are one contract.

**Engine (decided task 23, verified against current docs):** RN `FlatList`. It is already virtualized, adds zero dependencies, and fixed-height rows + `getItemLayout` is its best case. `@shopify/flash-list` v2 is rejected for v0: it is a **native** dependency, and `08-stack-and-repo.md` §2.2 is explicit that SDK 57 is fresh and third-party native libs may lag — its declared peer range (`react-native: '*'`) carries no compatibility signal for RN 0.86, and its recycling advantage is largest for variable-height rows, which we do not have. `@legendapp/list` (100% TypeScript, no native module, drop-in FlatList API) is the **pre-vetted swap target** if the on-device perf gate (`testing-guide` §4.2) fails.

## 4. Offline-first UI rules (normative)

These rules are the visible half of the architecture. Violating them misrepresents the system's own model.

1. **Every action is optimistic and succeeds locally, instantly.** A command appends locally and projections update the UI immediately (04-module-contract §5.1, FR-1136). There is no "saving…" phase visible to the user for local writes.
2. **Never a network spinner on a local action.** No button, screen, or flow may wait on, mention, or fail because of the network for any command. The words "no connection" must never gate a local write.
3. **Pending is a chip, not a warning** (§3.5). Unsynced ≠ unsaved. Copy must never imply the user's action is at risk merely because it hasn't synced.
4. **Rejected is loud and persistent** — chip + `danger` banner + Sync Status listing, until acknowledged. Silent rejection is unacceptable (05-operation-log §8, PRD-012 §6).
5. **Staleness is ambient and escalates** per §3.6 — quiet at `fresh`, warning banner at `warning`, loud at `stale` (levels and thresholds per `03-state-machines.md` §8; FR-1134). Freshness metadata ("last synced …") renders in `type.caption` `textMuted`, formatted via the label catalog.
6. **Network state is ambient, never blocking**: the header sync chip (§8.1) is the only always-on network affordance. Offline shows a neutral (not red) offline glyph — offline is a normal operating mode, not an error.
7. **Live updates are calm.** Pulled remote ops update lists in place via `useQuery` re-render (04-module-contract §7); no toast/flash per remote change.

## 5. Mandatory screen states — ship all four or fail review

Every screen (including every future module screen) ships **loading / empty / error / unauthorized**. A screen missing any of the four fails `review-wave`. Reviewers exercise all four (checklist §9).

| State | Must contain | Must NOT |
| --- | --- | --- |
| **Loading** | Treatment per §3.9 policy; geometry-stable; strings (if any) from label catalog | Block on network; show for local queries resolved < 300 ms |
| **Empty** | EmptyState (§3.8): icon, title, hint; create-CTA iff user holds the create permission | Be shown for permission-denied (FR-1036); read as an error |
| **Error** | What failed (label-catalog message keyed by `DomainError.code`), retry action, error code (`type.caption`) for support | Show raw exception text; blame the network for a local failure; dead-end without retry/back |
| **Unauthorized** | Explicit permission-denied title + body ("ask your store owner" guidance), back CTA. Distinct from Empty — a denied query returns a permission error, not an empty list (FR-1036); denial is logged at the command/query layer (FR-1045) | Masquerade as Empty; leak data about what exists; hide the fact of denial |

## 6. Accessibility floor (hard gates)

1. **Contrast ≥ 4.5:1** for all text and meaningful icons against their actual background (§1.1 pairs are pre-validated; new pairs must be checked). Disabled-state text is the only exemption.
2. **Touch targets ≥ 48 dp** with ≥ 8 dp separation (§1.4).
3. **No color-only signaling.** Every status is color + icon and/or text: chips carry icons, banners carry icons, input errors carry icon + message. A colorblind cashier in a bright shop must lose nothing.
4. Interactive elements set `accessibilityRole` and a label-catalog-sourced `accessibilityLabel`; disabled/busy states set `accessibilityState`.
5. Text respects OS font scaling; layouts survive 1.3× (§1.2).

## 7. RN implementation notes

- **Tokens + components live in `packages/ui` (`@bolusi/ui`)** — a contended shared package (CLAUDE.md §4): changes serialize, land before dependents.
- **`StyleSheet.create` with token references only.** No styling library in v0 — no NativeWind/Tamagui/styled-components/Restyle. Justification (normative): each adds JS bundle weight and runtime style-resolution work on Hermes, where the 2GB-RAM device budget (NFR-1101, NFR-1103) is already tight; a token file + StyleSheet is zero-dependency and fully sufficient for this palette-closed system. Revisit only via this doc.
- **No `react-native-reanimated` in v0.** Importing it inflates Android memory ~25–30% under SDK 57/RN 0.86 Hermes (verified stack research, expo caveats). v0 animation budget: `ActivityIndicator` and layout-free opacity via the built-in `Animated` API only. No Lottie.
- **Lint enforcement** (CI): (a) no color/size literals in `.tsx` outside `tokens.ts`; (b) no JSX string literals — all copy via the label catalog (`07-i18n.md` owns the rule); (c) no `reanimated`/styling-lib imports.
- **Lists:** consumed through the §3.13 `List` primitive rather than a raw `FlatList` / `.map()` — a convention until task 24's screen import-boundary rule enforces it (§3.13). `List` wraps RN `FlatList` (no `@shopify/flash-list` dep in v0 — see §3.13 for the verified engine comparison and the pre-vetted swap target) with fixed-height rows + `getItemLayout`, `windowSize` ≈ 7, `initialNumToRender` ≈ 10, `removeClippedSubviews` on Android. Cursor pagination via query `nextCursor` (04-module-contract §6) with `onEndReached`.
- **Images:** `expo-image` (first-party, disk-cached, downsamples to layout size — required for media thumbnails on 2GB RAM). Never render a full-resolution capture into a thumbnail slot.
- **Icons:** `@expo/vector-icons` (already in the Expo SDK dependency tree — no new native dep), restricted to a named-icon whitelist exported from `@bolusi/ui` (`Icon` component); direct glyph imports in screens fail review.
- **Pressables:** `Pressable` with `android_ripple` bounded to the target; no third-party touchable libs.
- Expo SDK 57 / RN 0.86 / React 19.2, EAS development builds (pinned stack) — no design-system code may assume Expo Go.

## 8. Screen-shell conventions

### 8.1 AppShell (every screen)

```
┌──────────────────────────────┐
│ Header (56): [back 48] Title │  Title type.title (list roots) / type.heading (details)
│           [SyncChip][Avatar] │  ← both always present, both 48dp targets
├──────────────────────────────┤
│ Banner slot (§3.6, max one)  │
├──────────────────────────────┤
│ Content (padding space.lg)   │
├──────────────────────────────┤
│ Bottom action bar (optional) │  primary Button, 56dp, above safe-area
└──────────────────────────────┘
```

- **SyncChip** (header, ambient): states `synced` (subtle cloud-check, `textMuted`), `pending` (clock + count of `local` ops), `syncing` (small spinner), `offline` (neutral cloud-off glyph — NOT red), `attention` (`danger` dot — any rejected op or revocation). Tap → Sync Status screen. This chip is the only permanent network affordance (§4 rule 6).
- **Avatar button**: current user's initials on `surfaceAlt` disc; tap → User Switcher. Reinforces attribution on shared devices (PRD-011 §2).
- Android hardware back always equals the header back action. Wizard flows confirm via ConfirmSheet before discarding non-empty input.
- **A module surface mounted at a shell route owns its own internal navigation** (NotesList → NoteDetail → NoteEditor), which the shell's gate deliberately cannot see. So while such a surface is off its root it **publishes a back/leave delegate to the shell** (`navigation/surface.ts`), and the shell routes BOTH hardware back and every header-chrome tap (sync chip, language chip, avatar) through it rather than unmounting the surface. This is what makes the two rules above hold across module screens: hardware back runs the surface's own back instead of exiting the app, and a chrome tap on an editor with unsaved input raises that editor's discard ConfirmSheet instead of silently destroying the draft. A leave proceeds only on confirm; a clean surface leaves immediately.

### 8.2 User Switcher (PRD-011 §6.1, FR-1012/13)

- Full-screen; also the idle-lock screen (FR-1015). No header back when acting as lock.
- Grid of user cards (2 columns): **Avatar `switcher` (96)**, name `type.body`, role name `type.bodySm` `textMuted`. Card height ≥ 88, sorted by most-recently-active.
- Avatars render per §3.12: **initials on the user's stable identity hue** (§1.5) — not a uniform grey disc. The directory carries `photoMediaId` from day one (`api/02-auth.md` §5.2 bundle) but v0 ships no photo-upload UI (roadmap), so initials are the only v0 rendering; a photo slots into the same geometry without layout change.

> **Changed 2026-07-15 (task 23).** Previously "initials on `surfaceAlt`, avatar (48)". That made every user an identical grey disc at bullet-point size, which defeats the purpose PRD-011 §6.1 states outright — these users find themselves by face, not by reading a name. On the ONE screen where identity *is* the content, identity gets the space and the colour.
- Tap card → PIN pad (§8.3). Whole switch ≤ 5 s budget (NFR-1003) — no animations, no confirmation screens.
- Deactivated users never appear. Mandatory states: loading (skeleton cards), empty (no enrolled users → CTA to Device Enrollment §8.5), error, unauthorized (n/a — pre-auth surface renders error instead).

### 8.3 PIN Pad screen

- Selected user's avatar + name on top (confirms WHO is entering), PinPad component (§3.3) centered in the thumb zone, "switch user" secondary action beneath.
- Verification is local and offline (FR-1010); lockout per FR-1011 renders PinPad `locked`. A successful switch appends `auth.user_switched` (FR-1014) — optimistic like everything else.

### 8.4 Sync Status screen (the SyncChip / Banner destination)

Content top-to-bottom:

1. **Status header**: last successful sync (`type.display` relative time + absolute `type.caption`), staleness-tier icon.
2. **Counters** (Cards): pending ops, pending media — derived counts recomputed on demand per `01-domain-model.md` §5.2, never stored — each with tabular `type.display` numbers.
3. **Manual sync** primary Button — the pull-to-refresh equivalent trigger (api/01-sync §5e); `busy` while the loop runs; failure shows inline error (backoff continues in background — never modal).
4. **Rejected operations list** (only when non-empty, section header in `color.danger`): ListRow per rejected op — op type label, time, rejection code; tap → detail with `rejectionCode`/`rejectionReason` (05-operation-log §2.3/§8) and label-catalog explanation + prescribed next step per code.
5. **Media queue** (when non-empty): ListRow per item with `uploadStatus` chip — `pending`/`uploading` (neutral, progress %), `failed` (danger chip + retry action → back to `uploading`), `uploaded` rows drop off (states per `03-state-machines.md` §MediaItem).
6. Devices section is NOT here — device management is its own surface (PRD-011 §6.5, v0 minimal).

### 8.5 Device Enrollment (full-screen wizard, §3.10)

Steps ("1/3" progress in header): (1) owner login form — `loginIdentifier` + password TextInputs per `api/02-auth.md` §4 (`POST /v1/auth/login`; there is no enrollment code), (2) pick the store, with tenant + store shown and confirmed BEFORE binding (wrong-store enrollment is the likely user error — make it visible), (3) done + first-user PIN setup handoff. Each step: one decision, primary Button bottom-anchored, back preserved. Errors inline (bad credentials, rate-limited), never toast. A `revoked` device (terminal, `03-state-machines.md` §Device) lands here to re-enroll, with a `danger` banner explaining why.

### 8.6 Notes reference module screens (04-module-contract §8)

These screens are the ergonomics testbed for every future module screen — they must use only §3 components and exhibit §4–§5 completely.

| Screen | Shape |
| --- | --- |
| **NotesList** | AppShell + FlatList of ListRow: title (primary), body preview + relative time (secondary), sync chip (trailing, §3.5), media-attachment glyph when present. Cursor pagination; live update on pulled remote ops; archived notes filtered by default with a toggle. All four §5 states (empty CTA "create note" iff `notes.create`). |
| **NoteEditor** (create/edit) | Full-screen flow: title + body TextInputs, optional media attach (capture per `06-media-pipeline.md`), primary "Save" bottom-anchored → command appends optimistically and returns to list instantly (no spinner — §4.2). Unsaved-input back press → ConfirmSheet. |
| **NoteDetail** | Card with title/body/media thumbnail (`expo-image`), meta line (author, time, `type.caption`), sync chip in header area; actions: edit (secondary), archive (destructive → ConfirmSheet). A rejected op on this note renders the `danger` banner inline on this screen too. |

The permission-denial exit (user without `notes.create`, 04-module-contract §8) must render the §5 Unauthorized state — this is the reference proof that unauthorized ≠ empty.

## 9. Review checklist (design-system gate in `review-wave`)

- [ ] All four §5 states implemented and reachable (reviewer navigates to each)
- [ ] No color/size/string literals in screen code (lint green)
- [ ] Every interactive element ≥ 48 dp; adjacent targets ≥ 8 dp apart; destructive not adjacent to primary
- [ ] No network affordance on any local action; sync chips derive from op bookkeeping only
- [ ] Banner priority honored; rejected ops loud; staleness tiers correct against `03-state-machines.md`
- [ ] No new deps (styling/animation/icon/font) introduced
- [ ] Text survives 1.3× font scale and ID/EN length variance without truncation
- [ ] All status signals carry icon or text alongside color
