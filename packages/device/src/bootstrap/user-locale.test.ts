// TASK 138 item 4 — the per-user locale emit wiring. Asserts the writer runs the REAL registered
// `platform.setLocale` command (from `@bolusi/core`) for the ACTING user, and that a non-selectable
// locale never reaches the immutable op log. The runtime is faked to the two methods the helper uses
// (`runtimeFor` → `commands.createContext`/`commands.execute`) — the command wiring is what's under test.
import { LOCALES, SELECTABLE_LOCALES, type Locale } from '@bolusi/i18n';
import { platformModule } from '@bolusi/core';
import { describe, expect, it, vi } from 'vitest';

import { createUserLocaleWriter } from './user-locale.js';

const IDENTITY = {
  tenantId: '01920000-0000-7000-8000-00000000t001',
  storeId: '01920000-0000-7000-8000-00000000s001',
  userId: 'u-acting',
  deviceId: '01920000-0000-7000-8000-00000000d001',
} as const;

function fakeRuntime() {
  const execute = vi.fn(async () => ({ ops: [], result: { locale: 'x' }, timestamp: 0 }));
  const createContext = vi.fn((userId: string) => ({ userId }));
  // `runtimeFor` returns a `CommandRuntime` whose `createContext`/`execute` sit DIRECTLY on it.
  const runtimeFor = vi.fn(() => ({ createContext, execute }));
  return { runtime: { runtimeFor } as never, runtimeFor, createContext, execute };
}

const nonSelectable = LOCALES.find((l) => !SELECTABLE_LOCALES.includes(l as never));

describe('createUserLocaleWriter (task 138 item 4)', () => {
  it('emits platform.setLocale for the ACTING user with the chosen locale', async () => {
    const rt = fakeRuntime();
    const write = createUserLocaleWriter(rt.runtime, IDENTITY as never);
    await write(SELECTABLE_LOCALES[0] as Locale);
    // Bound to the acting user (entityId = userId, 05 §9): the ctx is created for that user.
    expect(rt.createContext).toHaveBeenCalledWith('u-acting');
    expect(rt.execute).toHaveBeenCalledTimes(1);
    expect(rt.execute).toHaveBeenCalledWith(
      platformModule.commands.setLocale,
      { locale: SELECTABLE_LOCALES[0] },
      expect.anything(),
    );
  });

  it('a NON-selectable locale emits no op (never into the immutable, replicated log)', async () => {
    // `zh` exists in the locale model but is never offered by the settings screen; a value that fails
    // the command's own `z.enum(SELECTABLE_LOCALES)` input must not be signed into history.
    expect(nonSelectable).toBeDefined();
    const rt = fakeRuntime();
    const write = createUserLocaleWriter(rt.runtime, IDENTITY as never);
    await write(nonSelectable as Locale);
    expect(rt.execute).not.toHaveBeenCalled();
  });
});
