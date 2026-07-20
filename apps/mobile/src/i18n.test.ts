// The i18n boot's DIAGNOSTICS wiring (task 112) — the second half of the one-channel binding.
//
// `@bolusi/i18n`'s `I18nLogger` defaults to a no-op because the package is platform-free, and its
// header said "the app wires the real client diagnostics log at init". No app did: `bootstrapI18n`
// called `initI18n({ locale })` with no `logger`, so every §6 missing-key/fallback warning went to
// the no-op and was invisible on-device. This suite drives the REAL `bootstrapI18n` down to the REAL
// production sink (`console.warn`, via ports/diagnostics.ts) — the same object the command runtime
// binds as its denial-audit sink (§2.8, one channel not two).
//
// FALSIFIED (§2.11): dropping `logger: consoleDiagnostics` from `bootstrapI18n` leaves the locale
// assertion and the degraded RENDER assertion green — the key still humanizes, i18n still boots —
// while the "the warning was reported" assertion fails cleanly. Restore → green. Reported in task 112.
import { getI18nInstance } from '@bolusi/i18n';
import { expect, test, vi } from 'vitest';

import { bootstrapI18n, DEVICE_LOCALE_KEY, type LocaleStorePort } from './i18n.js';

function storeWith(stored: string | null): LocaleStorePort {
  return {
    read: (key: string) => Promise.resolve(key === DEVICE_LOCALE_KEY ? stored : null),
    write: () => Promise.resolve(),
  };
}

test('bootstrapI18n binds the app diagnostics sink, so a §6 missing-key warning is actually observable', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    expect(await bootstrapI18n(storeWith('en'))).toBe('en');

    // A key in NO catalog, unique to this test so `warnOnce`'s per-session dedupe cannot have
    // consumed it already. This is §6's emergency degradation path: it renders the humanized leaf.
    const rendered = getI18nInstance().t('bolusi.task112.absentEverywhere' as never);
    expect(rendered, 'the raw dotted key is never shown').not.toContain('bolusi.task112');

    // ...and the degradation was REPORTED. Matched on the key carried in the structured meta rather
    // than on the message wording, so a reworded diagnostic cannot pass this for the wrong reason.
    const reported = warn.mock.calls
      .map((call) => call[1] as Record<string, unknown> | undefined)
      .find((meta) => meta?.key === 'bolusi.task112.absentEverywhere');
    expect(
      reported,
      'the missing key must reach the app diagnostics sink (the logger binding is live)',
    ).toBeDefined();
  } finally {
    warn.mockRestore();
  }
});
