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
  roleKeys: ['store_owner'],
};

const READY: SwitcherState = { kind: 'ready', users: [USER] };

function renderSwitcher(
  mode: 'lock' | 'choose',
  chip: { readonly syncChip?: 'synced' | 'pending'; readonly pendingCount?: number } = {},
) {
  return render(
    <SwitcherScreen
      state={READY}
      mode={mode}
      // As the lock there is deliberately no back (§8.2); as the chooser there is.
      onBack={mode === 'lock' ? null : vi.fn()}
      onSelect={vi.fn()}
      onRetry={vi.fn()}
      onUnauthorizedBack={vi.fn()}
      syncChip={chip.syncChip ?? 'synced'}
      pendingCount={chip.pendingCount ?? 0}
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

describe("the pending chip announces THIS screen's unsent-op count (task 144 review)", () => {
  // The `pending` a11y label interpolates the count of unsent ops. This screen takes `syncChip` as a
  // bare state and builds the label map itself, so it must thread its own `pendingCount` into the
  // builder. A screen that dropped that prop would announce a CONSTANT — the old `?? 0` default,
  // "0 perubahan belum terkirim" (0 unsent) — on a chip that is `pending` precisely because ops ARE
  // unsent, the one channel §6.3/§6.4 says must carry the state. The regression was exactly this:
  // three screens called the builder with no count. Copy is never asserted (T-4) — only that two
  // different counts yield two different announcements, which a constant can never do.
  test('a different count changes the announcement — the prop reaches the label, not a constant', () => {
    const few = renderSwitcher('choose', { syncChip: 'pending', pendingCount: 3 });
    const many = renderSwitcher('choose', { syncChip: 'pending', pendingCount: 9 });
    const fewLabel = few.get('ui.syncChip').props['accessibilityLabel'];
    const manyLabel = many.get('ui.syncChip').props['accessibilityLabel'];
    expect(fewLabel).not.toBe(manyLabel);
  });
});

describe("the card shows the user's role line, driven by roleKeys (design-system §8.2, item 6)", () => {
  // The role name lives ONLY here — model.ts stays copy-free — so this is the only place the wiring
  // `roleKeys → <Text testID=switcher-user-role-*>` is observable. Precedence (store_owner over
  // staff) is proven at the core layer (`resolveDisplayRoleKeys`); this file proves the field is
  // rendered when present and OMITTED when empty. Copy is never asserted (T-4) — only the testID's
  // presence/absence, which a hardcoded label could not make conditional.
  function renderUser(roleKeys: readonly string[]) {
    const user: SwitcherUser = { ...USER, roleKeys };
    return render(
      <SwitcherScreen
        state={{ kind: 'ready', users: [user] }}
        mode="choose"
        onBack={vi.fn()}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
        onUnauthorizedBack={vi.fn()}
        syncChip="synced"
        pendingCount={0}
        onOpenSync={vi.fn()}
      />,
    );
  }

  test('a user with a role renders the role line', () => {
    const screen = renderUser(['store_owner']);
    expect(screen.query(`switcher-user-role-${USER.id}`)).not.toBeNull();
  });

  test('POSITIVE CONTROL: a user with no role grant renders NO role line', () => {
    // Without this, the test above would pass on a screen that printed a role line unconditionally —
    // an empty muted line under every unroled name, and a raw key for any role with no catalog row.
    const screen = renderUser([]);
    expect(screen.query(`switcher-user-role-${USER.id}`)).toBeNull();
  });
});
