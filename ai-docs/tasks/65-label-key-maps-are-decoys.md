# TASK 65 — every mobile screen exports a `*_KEY` label map its tests assert and its screen ignores: the same decoy as `canAttempt`, four more times

**Status:** todo
**Priority:** MEDIUM — **no live bug found** (the hardcoded `t()` calls and the maps agree today). The defect is the same as task 60's: the label-key coverage sits on a map nothing renders, and the mapping that ships has none of it. §2.8 (one implementation) — there are two copies of every screen's view→label-key mapping.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** —

## The finding (task 60's semantic sweep)

Task 60 deleted `canAttempt` — production code, 11 sound tests, zero callers, a live path (`pinPadState`) doing the job. The knip sweep that proved that case then found **the same shape, systematically, across the mobile screen layer**:

| Export | Defined | The live path that actually ships the same mapping |
| ------ | ------- | -------------------------------------------------- |
| `PIN_MESSAGE_KEY` | `screens/pin/model.ts:112` | `PinScreen.tsx:136-140` — `messageFor()` hardcodes `t('auth.pin.wrong')`, `t('auth.pin.wait')`, `t('auth.pin.lockedOut')` |
| `SWITCHER_KEY` | `screens/switcher/model.ts:184` | `SwitcherScreen.tsx:105` — `t('auth.switcher.title')` |
| `REASSURANCE_KEY` | `screens/sync-status/model.ts:171` | `SyncStatusScreen.tsx` |

Each map is `as const satisfies Record<State['kind'], string>` — well-typed, correct, and **asserted by its model.test.ts** (`PIN_MESSAGE_KEY` at `model.test.ts:65/96/151`). Each screen then re-writes the same mapping as a `switch` of literal `t('…')` calls. **The tests assert the copy that does not ship.**

So: change `messageFor`'s `delayed` arm to render `auth.pin.lockedOut` — a real copy bug, the "PIN terkunci, ask the owner" text shown to someone who just needs to wait 30 s, which `model.ts`'s own header calls out as the thing that must never happen — and **every `PIN_MESSAGE_KEY` assertion stays green.** Same as task 60: the assertions are sound, their subject is not on the path.

`satisfies Record<…>` is what makes this comfortable: it proves the map is *total over the union*, which reads as "every state's copy is covered". It proves nothing about what the screen renders.

## Also in the sweep's class-(a) list (apps/mobile, tested, not shipped)

- `changeLocale` (`settings/model.ts:112`), `setMuted` (`settings/model.ts:117`) — async ops, `SettingsScreen.tsx` exists. Determine per item whether these are decoys (a live path does it) or **built-ahead-of-consumer** (the screen takes callbacks from a caller not yet built). The two need different fixes; do not batch them with the `*_KEY` rows without checking.
- `classifyFailure` (`enrollment/model.ts:203`).

## Acceptance

- For each row: **decide decoy or not-yet-wired, and say which.** A decoy is deleted and its coverage re-pointed at the shipping path (task 60's pattern); a not-yet-wired export is left alone and noted against its consumer's task.
- For the `*_KEY` maps specifically, §2.8 says **pick one**: either the screen renders `t(PIN_MESSAGE_KEY[view.kind])` (the map becomes load-bearing, the existing tests become real), or the map is deleted and the tests assert the screen's own output. Note the wrinkle that made task 60 leave this alone: `messageFor`'s `wrong` arm appends a *second* key (`auth.pin.attemptsLeft`) that the map has no slot for, and its `entry` arm returns `undefined` against the map's `null` — so wiring is a small design decision, not a mechanical substitution.
- **THE GUARD** (§2.11/T-14): break the shipping mapping (e.g. `messageFor`'s `delayed` arm) and watch the label-key tests go **RED**. Report "broke X, saw Y fail, reverted". Today they stay green — confirm that first, in that direction (T-11).
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green — read the output (§2.1).

## Note

Found by the semantic sweep task 60 was required to build, on the first run whose controls passed. The grep sweep that preceded it reported **109 findings and missed every row above** — and missed `canAttempt` itself, because a *comment* mentioning it counted as a call (T-16a).

Worth carrying: task 60's finding was filed as one function. It was a **class**, and the class was only visible to an instrument that could answer *"is this called?"* — which no text search can (T-12: find the mechanism, then sweep the class; T-16(3): for "is this called?", use the language service).
