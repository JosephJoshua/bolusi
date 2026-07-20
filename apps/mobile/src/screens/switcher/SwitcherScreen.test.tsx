// SwitcherScreen renders the idle-LOCK banner only when it is acting as the lock (design-system §8.2,
// SEC-AUTH-08) — this file mounts the real screen to prove the `mode` prop is wired through.
//
// ── WHY THIS FILE EXISTS (task 69) ──────────────────────────────────────────────────────────────
// `model.test.ts` covers the switcher's ordering, chunking, and state derivation. None of it renders
// the screen, so nothing sees the one wiring that lives ONLY in `SwitcherScreen`: `mode === 'lock'`
// draws `<Banner … testID="switcher-lock-banner">`, and any other mode draws nothing. That banner is
// SEC-AUTH-08's whole reason the idle lock is tolerable — it tells a technician, before they ask,
// that the work they were typing is safe. A refactor that dropped the `mode === 'lock' ?` guard would
// leave every model test green while the lock lost its explanation (or a `choose` switch grew one).
//
// The assertion is presence/absence of a testID (public structure), never the banner's copy — T-4.
import { describe, expect, test, vi } from 'vitest';

import { render } from '../../../../../packages/ui/test/render.js';

import { SwitcherScreen } from './SwitcherScreen.js';
import type { SwitcherState, SwitcherUser } from './model.js';

const USER: SwitcherUser = {
  id: 'u-siti',
  name: 'Siti Rahayu',
  photoMediaId: null,
  lastActiveAt: 3_000,
  needsFirstPin: false,
};

const READY: SwitcherState = { kind: 'ready', users: [USER] };

function renderSwitcher(mode: 'lock' | 'choose') {
  return render(
    <SwitcherScreen
      state={READY}
      mode={mode}
      // As the lock there is deliberately no back (§8.2); as the chooser there is.
      onBack={mode === 'lock' ? null : vi.fn()}
      onSelect={vi.fn()}
      onEnroll={vi.fn()}
      onRetry={vi.fn()}
      syncChip="synced"
      onOpenSync={vi.fn()}
    />,
  );
}

describe('the idle-lock banner is wired to `mode` (design-system §8.2 / SEC-AUTH-08)', () => {
  test('mode="lock" renders the lock banner — the screen tells the user their work is safe', () => {
    const screen = renderSwitcher('lock');
    expect(screen.query('switcher-lock-banner')).not.toBeNull();
  });

  test('POSITIVE CONTROL: mode="choose" renders NO lock banner — the banner is driven by the mode', () => {
    // Without this, the test above would pass on a screen that showed the lock banner unconditionally,
    // alarming every ordinary user-switch with a lock explanation that does not apply.
    const screen = renderSwitcher('choose');
    expect(screen.query('switcher-lock-banner')).toBeNull();
  });
});
