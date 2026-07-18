// Locale vocabulary (07-i18n §1) — the SINGLE home for which language codes exist and which a user
// may select. It lives here, in the zod-only platform-free package (08 §3.2), because BOTH consumers
// import it: @bolusi/i18n re-exports it for the in-app toggle (07-i18n §1), and @bolusi/core builds
// the `platform.setLocale` input + `platform.user_locale_changed` payload enums from it (07-i18n
// §1.1). @bolusi/i18n owns i18next and drags a runtime library, so @bolusi/core may not import it
// (08 §3.3); a shared zod-only home is the only way the toggle and the op enum cannot drift. Before
// task 77 this was TWO hardcoded copies (`SELECTABLE_LOCALES` here as `LOCALE_VALUES` in core) with
// no gate comparing them — adding `zh` to one silently broke the other (CLAUDE.md §2.8).
//
// Adding a locale is a change to 07-i18n §1 first, then this file.

/** BCP 47 primary language subtags — never a region tag; region is a formatting concern (07-i18n §5). */
export type Locale = 'id' | 'en' | 'zh';

/** `zh` is scaffolded (type + fallback chain) but has no catalog and is not selectable in v0. */
export const LOCALES: readonly Locale[] = ['id', 'en', 'zh'];

/** Source language, default, and the tail of every fallback chain (07-i18n §1, §6). */
export const DEFAULT_LOCALE: Locale = 'id';

/**
 * The locales a user may choose. ONE list feeds two consumers: the in-app toggle (@bolusi/i18n,
 * 07-i18n §1) AND the `platform.setLocale` input / `platform.user_locale_changed` payload enum
 * (@bolusi/core, 07-i18n §1.1) — so the toggle can never offer a locale the op rejects, nor the op
 * accept one no toggle offers. A `const` tuple so `z.enum(SELECTABLE_LOCALES)` narrows it to the
 * literal union rather than widening to `Locale`; `satisfies readonly Locale[]` proves every entry is
 * a real `Locale`. `zh` becomes selectable in V2 (07-i18n §1.1) — added HERE, once.
 */
export const SELECTABLE_LOCALES = ['id', 'en'] as const satisfies readonly Locale[];

/** Is `value` one of the scaffolded locales (07-i18n §1)? Admits `zh`; selectability is separate. */
export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
