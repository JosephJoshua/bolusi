# TASK 76 — `user_prefs.locale DEFAULT 'id-ID'` is an **Intl tag**, not a `Locale`; the column holds `'id' | 'en'`

**Status:** todo
**Priority:** MEDIUM — inert today, but it is a decoy pointed directly at task 21, which is unstarted and will read this column.
**Depends on:** —
**Filed by:** impl-17, 2026-07-16

## The finding

Both engines declare (10-db-schema §8 Postgres, §9.6 SQLite):

```sql
locale text NOT NULL DEFAULT 'id-ID'
```

But `'id-ID'` is **not a `Locale`**. `packages/i18n/src/locale.ts` (owning doc 07-i18n §1):

```ts
export type Locale = 'id' | 'en' | 'zh';        // "BCP 47 primary language subtags — never a region tag"
export const INTL_LOCALE_TAG: Record<Locale, string> = { id: 'id-ID', en: 'en-GB', zh: 'zh-CN' };
```

`'id-ID'` is `INTL_LOCALE_TAG.id` — a *formatting* tag, which 07-i18n §5 keeps deliberately separate from the locale itself ("region is a formatting concern"). The values this column actually holds are `'id' | 'en'`, because 07-i18n §1.1 pins the op payload to `z.enum(['id','en'])` and the applier (`packages/core/src/platform/projections/user-prefs.ts`, task 17) writes exactly what the payload carries.

## Why it is inert TODAY and dangerous TOMORROW

The default is **unreachable through the fold**: `userLocaleChangedApplier` always supplies `locale`, so the DEFAULT clause never fires. Nothing is wrong in production right now, which is exactly why nobody would find it.

It is a **decoy** (CLAUDE.md §2.11's "the comment was the guard" class, in DDL form): a reader who trusts the DDL concludes this column holds Intl tags. The reader most likely to do so is **task 21**, which is `todo` and whose whole job is to read `user_prefs.locale` and compose a notification in it. A task-21 implementer who reads the DDL and writes `if (locale === 'id-ID')`, or who seeds `'id-ID'` in a fixture, gets a green test and a wrong production answer — and task 49's finding already documents that task 21's locale test seeds the row directly (T-14b).

Note the near-miss: task 49's write-up and task 17's brief both describe the trap as "falls back to **`id-ID`** forever", which is the DDL's vocabulary, not the `Locale` vocabulary. The wrong value is already circulating in prose.

## Scope

- Decide the intended value space for `user_prefs.locale` — almost certainly `Locale` (`'id'|'en'`), given 07-i18n §1.1's payload enum and §5's tag/locale split.
- `10-db-schema.md` §8 + §9.6: change the DDL default to `'id'` (or drop the default — see below) and say which vocabulary the column holds.
- **Consider dropping the DEFAULT entirely.** It is unreachable through the applier, and an unreachable default is a claim no test can check. 07-i18n §1.1's real rule is a READ-side fallback — "the UI locale becomes the incoming user's projected preference (**default `id` if none**)" — i.e. the fallback belongs to the reader when the ROW IS ABSENT, which a column default cannot express anyway (no row, no default).
- A migration is needed for the Postgres change (DDL migrations serialize globally — CLAUDE.md §4).
- Task 21 should read the corrected DDL; its locale-fallback matrix is the consumer.

## Related, same file, worth deciding together

`packages/core/src/platform/constants.ts`'s `LOCALE_VALUES = ['id','en']` is a **second statement** of `packages/i18n/src/locale.ts`'s `SELECTABLE_LOCALES`. They can drift and no gate compares them — see task 77.
