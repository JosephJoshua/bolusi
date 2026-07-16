# TASK 77 — the selectable-locale list is declared **twice** (`@bolusi/i18n` and `@bolusi/core`) and no gate compares them

**Status:** todo
**Priority:** LOW-MEDIUM — a §2.8 duplication whose drift mode is silent and user-visible.
**Depends on:** —
**Filed by:** impl-17, 2026-07-16 (self-reported: task 17 created the second copy)

## The finding

Two lists state which locales a user may choose, and nothing keeps them in step:

| where | what | owner |
| ----- | ---- | ----- |
| `packages/i18n/src/locale.ts` | `SELECTABLE_LOCALES: readonly Locale[] = ['id', 'en']` — "Offered by the in-app toggle in v0 (§1). `zh` joins in V2." | 07-i18n §1 |
| `packages/core/src/platform/constants.ts` | `LOCALE_VALUES = ['id', 'en'] as const` — the `platform.user_locale_changed` payload enum + the `setLocale` input enum | 07-i18n §1.1 |

## Why the duplication exists (and is not simply a mistake to delete)

`@bolusi/core` is **PURE TS** (08 §3.2: "all effects behind ports") and `@bolusi/i18n` depends on `i18next` / `i18next-icu` / `intl-messageformat`. Core importing i18n would drag a stateful runtime library into the pure package and, more concretely, core does not list `@bolusi/i18n` as a dependency at all. So the honest options are:

1. **Move the locale vocabulary to a package core may import.** `@bolusi/schemas` is already core's dependency, is zod-only and platform-free (its own header says so), and already owns the shared wire vocabulary. `Locale` / `SELECTABLE_LOCALES` arguably belong there, with `@bolusi/i18n` re-exporting them — one declaration, two consumers. This is probably the right answer, and it is a sibling of **task 72** (`mediaRefSchema` was ruled to `@bolusi/schemas` for a boundary reason of exactly this shape — worth deciding both at once, and 72 is unstarted).
2. **A gate that compares the two lists** and fails when they diverge. Cheaper, but it is a guard where a shared declaration would remove the hazard — CLAUDE.md §2.11 prefers closing by construction.

## The drift mode, concretely

07-i18n §1.1 says `zh` "becomes legal here in V2". When someone adds `zh`:

- Add it to `SELECTABLE_LOCALES` only → the in-app toggle **offers Chinese**, the user picks it, `setLocale`'s input enum **rejects it**, and the user sees a `VALIDATION_FAILED` on a language the app just showed them.
- Add it to `LOCALE_VALUES` only → the payload accepts `zh`, no toggle offers it, and the op type silently gains a value no catalog exists for (07-i18n §1: "`zh` is scaffolded … has no catalog").

Neither fails a test today. `pnpm i18n:check` reads catalogs, not these lists.

## Scope

- Pick option 1 or 2 above (1 preferred; decide alongside task 72, same boundary shape).
- If 1: move `Locale` / `LOCALES` / `SELECTABLE_LOCALES` to `@bolusi/schemas`; `@bolusi/i18n` re-exports (it owns `INTL_LOCALE_TAG` and the i18next wiring, which stay); `packages/core/src/platform/constants.ts` deletes `LOCALE_VALUES` and imports. `07-i18n.md` §1 is the owning doc and changes first.
- If 2: the gate must assert its own denominator (T-14) — that it compared two NON-EMPTY lists and found them equal. A gate that read two empty arrays and reported "identical" is this repo's signature failure.
- Falsify whichever ships (§2.11): add `zh` to one list only, watch the specific failure, revert.
