# TASK 212 — 9 of 12 op types render as "unknown" on the Sync Status rejected list

**Priority:** MEDIUM — user-visible, on the screen a shop opens precisely when something went wrong. Not a crash; the rejection reason still renders. What is lost is *which change* was rejected.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** a diagnostics sweep during task 211, 2026-09-23 (CLAUDE.md §2.7).

## The finding

`apps/mobile/src/screens/sync-status/SyncStatusScreen.tsx:269` renders each rejected op's type through `translateOpType(row.type)` into `sync.rejected.opMeta` (`'{opType} · {time}'`).

`translateOpType` (`packages/i18n/src/errors.ts:69`) derives `<module>.opType.<camelVerb>`, probes the source locale, and falls back to `core.opType.unknown` while emitting a `warnOnce` diagnostic.

**Only `notes.opType.*` exists.** `packages/modules/src/notes/screens/i18n.ts:43-45` provides exactly three labels — `noteCreated`, `noteBodyEdited`, `noteArchived`. The base catalog (`packages/i18n/src/generated/resources.ts`) carries `core.opType.unknown` and nothing else; grep finds no `auth.opType.*` or `platform.opType.*` anywhere in the repo.

Op types that therefore render as the fallback:

| Module | Op types with no label |
| ------ | ---------------------- |
| `auth` | `device_enrolled`, `pin_changed`, `pin_locked_out`, `pin_lockout_cleared`, `session_ended`, `user_switched` |
| `platform` | `conflict_detected`, `conflict_acknowledged`, `user_locale_changed` |

9 of the 12 op types in `01-domain-model` §6. Measured, not inferred — `translateOpType` run against the real catalogs with the notes module registered:

```
fallback string = "Perubahan"
ok       notes.note_created          -> "Catatan dibuat"
ok       notes.note_archived         -> "Catatan diarsipkan"
ok       notes.note_body_edited      -> "Isi catatan diubah"
FALLBACK auth.device_enrolled        -> "Perubahan"
FALLBACK auth.user_switched          -> "Perubahan"
FALLBACK auth.pin_changed            -> "Perubahan"
FALLBACK auth.pin_locked_out         -> "Perubahan"
FALLBACK auth.pin_lockout_cleared    -> "Perubahan"
FALLBACK auth.session_ended          -> "Perubahan"
FALLBACK platform.conflict_detected  -> "Perubahan"
FALLBACK platform.conflict_acknowledged -> "Perubahan"
FALLBACK platform.user_locale_changed   -> "Perubahan"
```

The degradation is softer than the key name suggests and worse for it: the row reads `Perubahan · 14:32` — "Change · 14:32" — which looks like a real label rather than a missing one. A shop whose device enrollment or PIN change was rejected cannot tell *which* change the rejection refers to, and nothing on screen indicates the label is absent.

## How it stayed invisible

The diagnostic that reports it is real and fires — `i18n: unknown op type 'auth.user_switched'; rendering unknown` — but **vitest surfaces console output only for tests that already failed**, so it never appeared in a green suite. Confirmed by construction: an unconditional `console.warn` planted in an executing code path (verified executing by swapping it for a `throw`) printed nothing on a passing test, and `--silent=false` did not lift it. The sweep that found this replaced the diagnostics sink with one that appends to a file, bypassing the capture entirely: 913 passing tests emitted 22 diagnostics.

This is the §2.11 family again — not a gate green for the wrong reason, but a **signal with no reader**.

## Fix direction

Per the 2026-08-05 owner ruling, op-type labels are module-provided, so the labels belong with their modules, not in the base catalog:

1. Add `auth.opType.*` and `platform.opType.*` label sets, registered the way `registerModuleCatalogs` already merges the notes catalog (`apps/mobile/src/bootstrap/module-catalogs.ts`).
2. Decide whether `auth`/`platform` get client catalogs of their own or whether these labels belong to a core-owned set — an **owner call** (§6), since it decides whether `auth` becomes a client-screen module.
3. Contended `@bolusi/i18n` + the label catalog (§4) — serialize against other i18n work.

## Acceptance

- `translateOpType` returns a real label, not the fallback, for every op type in `01-domain-model` §6 — asserted by enumerating that list programmatically rather than by a remembered set (T-12), so a future op type without a label reds.
- That test REDS today: `expect(translateOpType('auth.device_enrolled')).not.toBe(t('core.opType.unknown'))` fails on the current tree.
- `pnpm lint` / `pnpm typecheck` / mobile suite green.

## Related, deliberately NOT filed

The same sweep showed `i18n: unknown roleKey 'Notes'` ×14 and `'Owner'` ×2. Those are a **fixture** artifact: `live-shell-support.tsx` passes a role *display name* where `translateRoleKey` wants a role key. Production seeds real keys (`main_owner`, `store_owner`, `staff`) and resolves them — the emulator screenshot shows "Pemilik Utama" rendering correctly. No user-facing defect, so no task (§2.7).
