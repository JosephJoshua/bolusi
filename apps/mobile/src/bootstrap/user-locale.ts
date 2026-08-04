// TASK 138 item 4 — emit the per-user locale preference op. The op TYPE, its emit command
// (`platform.setLocale` → `platform.user_locale_changed`), the applier and the `user_prefs` projection
// ALL already ship in `@bolusi/core` (05-operation-log §9 — the one tenant-scoped v0 op, 07-i18n §1.1).
// What was missing was only this MOBILE emit wiring: nothing connected a locale change to the command,
// so `settings/model.ts`'s `SetLocalePreference` seam had "no provider, no caller" (task 138 filing).
//
// `Root.onSelectLocale` writes the DEVICE locale (07-i18n §1.2 — device-local, no op) AND calls this,
// so a user's choice also follows the USER to every device (§1.1) via a signed, replicated op.
import { platformModule, type CommandIdentity, type CommandRuntime } from '@bolusi/core';
import type { Locale } from '@bolusi/i18n';

import type { AppRuntime } from './runtime.js';

/**
 * A per-user-locale writer bound to the acting session's identity. Runs the registered
 * `platform.setLocale` command (tenant-scoped, 05 §9) through the command runtime, emitting a
 * `platform.user_locale_changed` op signed by this device with `entityId = userId`.
 *
 * The locale is validated against the command's OWN input schema (`z.enum(SELECTABLE_LOCALES)`): a
 * non-selectable locale (e.g. `zh`, in the locale model but never offered — 07-i18n) has no per-user
 * preference, so it is silently skipped rather than emitted into the immutable, forever-replicated log.
 * The settings screen only offers selectable locales, so the skip is a guard, not a live path.
 */
export function createUserLocaleWriter(
  runtime: AppRuntime,
  identity: CommandIdentity,
): (locale: Locale) => Promise<void> {
  // `runtimeFor` wants the DEVICE identity; a `CommandIdentity` carries those fields plus the acting
  // `userId`, so it is assignable, and the same object supplies the `createContext(userId)` the op's
  // `entityId = userId` scope rule (05 §9 item 5) needs.
  const command: CommandRuntime = runtime.runtimeFor(identity);
  const ctx = command.createContext(identity.userId);
  return async (locale) => {
    const parsed = platformModule.commands.setLocale.input.safeParse({ locale });
    if (!parsed.success) return;
    await command.execute(platformModule.commands.setLocale, parsed.data, ctx);
  };
}
