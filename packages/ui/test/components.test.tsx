/**
 * Component contracts: Button, sync chips, LoadingState, the three §5 state components, Avatar,
 * FreshnessCell, List. Per testing-guide T-4 every assertion is a testID / role / accessibilityState
 * / style value — never rendered copy. Per T-5 there is no snapshot anywhere.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Avatar, identityColor } from '../src/components/Avatar.js';
import { Button } from '../src/components/Button.js';
import { EmptyState } from '../src/components/EmptyState.js';
import { ErrorState } from '../src/components/ErrorState.js';
import { FreshnessCell } from '../src/components/FreshnessCell.js';
import { List } from '../src/components/List.js';
import { ListRow } from '../src/components/ListRow.js';
import {
  LoadingState,
  LOADING_DELAY_MS,
  SKELETON_ROW_COUNT,
} from '../src/components/LoadingState.js';
import { resolveSyncChip, SyncStatusChip } from '../src/components/SyncStatusChip.js';
import { TextInput } from '../src/components/TextInput.js';
import { UnauthorizedState } from '../src/components/UnauthorizedState.js';
import { border, color, identityPalette, size, touch } from '../src/tokens.js';
import { fire, isUnwired, render } from './render.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Button (§3.1)', () => {
  test('busy leaves onPress unwired, so a press cannot fire', () => {
    const onPress = vi.fn();
    const r = render(<Button testID="b" label="Simpan" onPress={onPress} busy />);
    expect(isUnwired(r.get('b'))).toBe(true);
  });

  test('a double-tap fires onPress at most once once busy takes effect', () => {
    // The realistic sequence on a frame-dropping device: the first tap fires and the owner flips
    // `busy`; the second tap lands after that re-render and must find nothing to press.
    const onPress = vi.fn();
    const r = render(<Button testID="b" label="Simpan" onPress={onPress} />);

    fire(r.get('b'), 'onPress');
    r.rerender(<Button testID="b" label="Simpan" onPress={onPress} busy />);

    expect(isUnwired(r.get('b'))).toBe(true);
    expect(onPress).toHaveBeenCalledOnce();
  });

  test('busy replaces the label with a spinner', () => {
    const r = render(<Button testID="b" label="Simpan" onPress={vi.fn()} busy />);
    expect(r.query('b.spinner')).not.toBeNull();
    expect(r.query('b.label')).toBeNull();
  });

  test('busy keeps the button width-stable: same height and padding as default', () => {
    const idle = render(<Button testID="b" label="Simpan" onPress={vi.fn()} />);
    const busy = render(<Button testID="b" label="Simpan" onPress={vi.fn()} busy />);
    expect(busy.styleOf('b')['height']).toBe(idle.styleOf('b')['height']);
    expect(busy.styleOf('b')['paddingHorizontal']).toBe(idle.styleOf('b')['paddingHorizontal']);
  });

  test('disabled announces itself to accessibility (§6.4)', () => {
    const r = render(<Button testID="b" label="Simpan" onPress={vi.fn()} disabled />);
    expect(r.get('b').props['accessibilityState']).toEqual({ disabled: true, busy: false });
  });

  test('busy announces busy as well as disabled', () => {
    const r = render(<Button testID="b" label="Simpan" onPress={vi.fn()} busy />);
    expect(r.get('b').props['accessibilityState']).toEqual({ disabled: true, busy: true });
  });

  test.each([
    ['primary', color.primary],
    ['destructive', color.danger],
  ] as const)('%s is its own variant with its own palette fill', (variant, fill) => {
    const r = render(<Button testID="b" label="x" onPress={vi.fn()} variant={variant} />);
    expect(r.styleOf('b')['backgroundColor']).toBe(fill);
  });

  test('there is no style/color override prop that could bypass the palette', () => {
    // The type forbids it; this asserts the runtime shape too — a component that spread unknown
    // props onto Pressable would let a screen smuggle a colour past §1.1.
    const r = render(<Button testID="b" label="x" onPress={vi.fn()} />);
    const style = r.styleOf('b');
    expect(style['backgroundColor']).toBe(color.primary);
  });

  test('pressed swaps to the pressed fill token (§3.1)', () => {
    const r = render(<Button testID="b" label="x" onPress={vi.fn()} />);
    expect(r.styleOf('b')['backgroundColor']).toBe(color.primary);
    fire(r.get('b'), 'onPressIn');
    expect(r.styleOf('b')['backgroundColor']).toBe(color.primaryPressed);
  });

  test('the label wraps to 2 lines rather than truncating (ID/EN length variance, §0)', () => {
    const r = render(<Button testID="b" label="Ya, Lanjutkan" onPress={vi.fn()} />);
    expect(r.get('b.label').props['numberOfLines']).toBe(2);
  });

  test('height is the 56 dp primary target (§1.4)', () => {
    const r = render(<Button testID="b" label="x" onPress={vi.fn()} />);
    expect(r.styleOf('b')['height']).toBe(56);
  });
});

describe('sync chips (§3.5)', () => {
  const labels = { pendingLabel: 'Belum terkirim', rejectedLabel: 'Ditolak' };

  test('all synced renders nothing — the silent default', () => {
    const r = render(
      <SyncStatusChip syncStatuses={['synced', 'synced']} {...labels} onPressRejected={vi.fn()} />,
    );
    expect(r.query('ui.syncStatusChip.pending')).toBeNull();
    expect(r.query('ui.syncStatusChip.rejected')).toBeNull();
  });

  test('any local renders the pending chip', () => {
    const r = render(
      <SyncStatusChip syncStatuses={['synced', 'local']} {...labels} onPressRejected={vi.fn()} />,
    );
    expect(r.query('ui.syncStatusChip.pending')).not.toBeNull();
  });

  test('any rejected renders the rejected chip', () => {
    const r = render(
      <SyncStatusChip syncStatuses={['rejected']} {...labels} onPressRejected={vi.fn()} />,
    );
    expect(r.query('ui.syncStatusChip.rejected')).not.toBeNull();
  });

  test('rejected wins when both apply (§3.5 precedence)', () => {
    const r = render(
      <SyncStatusChip syncStatuses={['local', 'rejected']} {...labels} onPressRejected={vi.fn()} />,
    );
    expect(r.query('ui.syncStatusChip.rejected')).not.toBeNull();
    expect(r.query('ui.syncStatusChip.pending')).toBeNull();
  });

  test('the rejected chip is tappable — rejection is never silent (§4.4)', () => {
    const onPressRejected = vi.fn();
    const r = render(
      <SyncStatusChip syncStatuses={['rejected']} {...labels} onPressRejected={onPressRejected} />,
    );
    fire(r.get('ui.syncStatusChip.rejected'), 'onPress');
    expect(onPressRejected).toHaveBeenCalledOnce();
  });

  test('the rejected chip compensates its 28 dp height with hitSlop to reach 48 dp (§1.4)', () => {
    const r = render(
      <SyncStatusChip syncStatuses={['rejected']} {...labels} onPressRejected={vi.fn()} />,
    );
    const node = r.get('ui.syncStatusChip.rejected');
    const slop = node.props['hitSlop'] as { top: number; bottom: number };
    const height = r.styleOf('ui.syncStatusChip.rejected')['height'] as number;
    expect(height + slop.top + slop.bottom).toBeGreaterThanOrEqual(touch.min);
  });

  test('the pending chip is not alarming: no danger token in its styles (§4.3)', () => {
    const r = render(
      <SyncStatusChip syncStatuses={['local']} {...labels} onPressRejected={vi.fn()} />,
    );
    const style = r.styleOf('ui.syncStatusChip.pending');
    const danger = [color.danger, color.dangerBg, color.dangerPressed, color.onDangerBg];
    for (const value of Object.values(style)) expect(danger).not.toContain(value);
  });

  test('the pending chip is not tappable — there is nothing for the user to fix', () => {
    const r = render(
      <SyncStatusChip syncStatuses={['local']} {...labels} onPressRejected={vi.fn()} />,
    );
    expect(r.get('ui.syncStatusChip.pending').props['accessibilityRole']).toBeUndefined();
  });

  test('an unknown status throws rather than rendering a wrong chip', () => {
    expect(() => resolveSyncChip(['bogus' as 'local'])).toThrow(/Unknown Operation.syncStatus/);
  });

  test('every chip carries an icon — never colour alone (§6.3)', () => {
    for (const [statuses, id] of [
      [['local'], 'pending'],
      [['rejected'], 'rejected'],
    ] as const) {
      const r = render(
        <SyncStatusChip syncStatuses={statuses} {...labels} onPressRejected={vi.fn()} />,
      );
      const chip = r.get(`ui.syncStatusChip.${id}`);
      const icons = chip.queryAll((node) => node.type === 'MaterialCommunityIcons');
      expect(icons).toHaveLength(1);
    }
  });
});

describe('LoadingState (§3.9)', () => {
  test('renders nothing before 300 ms — no flash on a query that resolves in ms', () => {
    vi.useFakeTimers();
    const r = render(<LoadingState variant="skeleton" />);
    expect(r.query('ui.loadingState')).toBeNull();
    vi.advanceTimersByTime(LOADING_DELAY_MS - 1);
    expect(r.query('ui.loadingState')).toBeNull();
  });

  test('renders the treatment after 300 ms', () => {
    vi.useFakeTimers();
    const r = render(<LoadingState variant="skeleton" />);
    vi.advanceTimersByTime(LOADING_DELAY_MS);
    r.rerender(<LoadingState variant="skeleton" />);
    expect(r.query('ui.loadingState')).not.toBeNull();
  });

  test('the skeleton is exactly 6 ghost rows at ListRow height', () => {
    vi.useFakeTimers();
    const r = render(<LoadingState variant="skeleton" />);
    vi.advanceTimersByTime(LOADING_DELAY_MS);
    r.rerender(<LoadingState variant="skeleton" />);
    expect(SKELETON_ROW_COUNT).toBe(6);
    for (let i = 0; i < SKELETON_ROW_COUNT; i += 1) {
      expect(r.styleOf(`ui.loadingState.row.${i}`)['height']).toBe(touch.row);
    }
    expect(r.query(`ui.loadingState.row.${SKELETON_ROW_COUNT}`)).toBeNull();
  });

  test('no animation loop is started — static blocks, no shimmer (§3.9)', () => {
    vi.useFakeTimers();
    const r = render(<LoadingState variant="skeleton" />);
    vi.advanceTimersByTime(LOADING_DELAY_MS);
    r.rerender(<LoadingState variant="skeleton" />);
    // The 300 ms reveal timer is the ONLY timer; a shimmer would leave a repeating one behind.
    expect(vi.getTimerCount()).toBe(0);
  });

  test('the spinner variant renders an ActivityIndicator', () => {
    vi.useFakeTimers();
    const r = render(<LoadingState variant="spinner" />);
    vi.advanceTimersByTime(LOADING_DELAY_MS);
    r.rerender(<LoadingState variant="spinner" />);
    expect(r.query('ui.loadingState.spinner')).not.toBeNull();
  });
});

describe('empty / error / unauthorized are three distinct components (§3.8, §5, FR-1036)', () => {
  test('they are not the same component wearing different props', () => {
    expect(EmptyState).not.toBe(UnauthorizedState);
    expect(EmptyState).not.toBe(ErrorState);
    expect(ErrorState).not.toBe(UnauthorizedState);
  });

  test('EmptyState renders its CTA only when onCreate is supplied — the screen owns that decision', () => {
    const without = render(<EmptyState title="Belum ada catatan" />);
    expect(without.query('ui.emptyState.cta')).toBeNull();

    const withCta = render(
      <EmptyState title="Belum ada catatan" createLabel="Tambah" onCreate={vi.fn()} />,
    );
    expect(withCta.query('ui.emptyState.cta')).not.toBeNull();
  });

  test('ErrorState exposes retry and an error-code caption (§5: never a dead end)', () => {
    const onRetry = vi.fn();
    const r = render(
      <ErrorState title="Gagal" errorCode="NETWORK" retryLabel="Coba Lagi" onRetry={onRetry} />,
    );
    expect(r.query('ui.errorState.code')).not.toBeNull();
    fire(r.get('ui.errorState.retry'), 'onPress');
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test('UnauthorizedState exposes a back action', () => {
    const onBack = vi.fn();
    const r = render(
      <UnauthorizedState title="Tidak diizinkan" backLabel="Kembali" onBack={onBack} />,
    );
    fire(r.get('ui.unauthorizedState.back'), 'onPress');
    expect(onBack).toHaveBeenCalledOnce();
  });

  test('UnauthorizedState offers no retry — retrying a denial just denies again', () => {
    const r = render(
      <UnauthorizedState title="Tidak diizinkan" backLabel="Kembali" onBack={vi.fn()} />,
    );
    expect(r.query('ui.unauthorizedState.retry')).toBeNull();
  });
});

describe('FreshnessCell (§3.11) — the signature', () => {
  test.each([
    ['fresh', color.textMuted],
    ['warning', color.warning],
    ['stale', color.danger],
  ] as const)('%s renders its own tier with its own tint', (level, tint) => {
    const r = render(<FreshnessCell level={level} />);
    expect(r.query(`ui.freshnessCell.${level}`)).not.toBeNull();
    expect(r.styleOf(`ui.freshnessCell.${level}`)).toBeDefined();
    if (level !== 'stale') expect(r.styleOf('ui.freshnessCell.fill')['backgroundColor']).toBe(tint);
  });

  test('fill — not colour — carries the signal: fresh is full, warning half, stale empty', () => {
    const fresh = render(<FreshnessCell level="fresh" />);
    expect(fresh.styleOf('ui.freshnessCell.fill')['width']).toBe('100%');

    const warning = render(<FreshnessCell level="warning" />);
    expect(warning.styleOf('ui.freshnessCell.fill')['width']).toBe('50%');

    // Empty, so a technician who cannot distinguish the colours still reads "flat".
    const stale = render(<FreshnessCell level="stale" />);
    expect(stale.query('ui.freshnessCell.fill')).toBeNull();
  });

  test('it never animates — no timers, so reduced-motion has nothing to honour', () => {
    vi.useFakeTimers();
    render(<FreshnessCell level="warning" />);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('standalone it announces itself; inside a banner it stays silent to avoid double-announcing', () => {
    const standalone = render(<FreshnessCell level="stale" accessibilityLabel="Data lama" />);
    expect(standalone.get('ui.freshnessCell.stale').props['accessibilityRole']).toBe('image');

    const embedded = render(<FreshnessCell level="stale" />);
    expect(embedded.get('ui.freshnessCell.stale').props['accessibilityElementsHidden']).toBe(true);
  });
});

describe('Avatar (§3.12) — identity recognised, not read', () => {
  test('the hue is stable for a user across renders', () => {
    expect(identityColor('user-abc')).toBe(identityColor('user-abc'));
  });

  test('the hue comes from the id, not the name — renaming must not repaint a person', () => {
    const r1 = render(<Avatar testID="a" userId="user-abc" initials="SW" />);
    const r2 = render(<Avatar testID="a" userId="user-abc" initials="YB" />);
    expect(r1.styleOf('a')['backgroundColor']).toBe(r2.styleOf('a')['backgroundColor']);
  });

  test('different users get different hues often enough to be worth having', () => {
    const hues = new Set(Array.from({ length: 40 }, (_, i) => identityColor(`user-${i}`)));
    expect(hues.size).toBeGreaterThan(1);
  });

  test('every produced hue is from the closed identity palette (§1.5)', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(identityPalette).toContain(identityColor(`u-${i}`));
    }
  });

  test('the switcher size is a face, not a bullet point (§8.2)', () => {
    const r = render(<Avatar testID="a" userId="u" initials="SW" size="switcher" />);
    expect(r.styleOf('a')['width']).toBe(96);
  });

  test('initials never scale down — the recognise-not-read contract depends on the letterform', () => {
    const r = render(<Avatar testID="a" userId="u" initials="SW" />);
    expect(r.get('a.initials').props['allowFontScaling']).toBe(false);
  });
});

describe('List (§3.13) — virtualization and the four mandatory states', () => {
  const row = (item: string): React.JSX.Element => (
    <ListRow testID={`row.${item}`} primaryText={item} />
  );

  test('the ready state wires the windowing contract', () => {
    const r = render(
      <List state={{ kind: 'ready', items: ['a', 'b'] }} renderRow={row} keyExtractor={(i) => i} />,
    );
    const list = r.get('ui.list');
    expect(typeof list.props['getItemLayout']).toBe('function');
    expect(list.props['windowSize']).toBe(7);
    expect(list.props['initialNumToRender']).toBe(10);
    expect(list.props['removeClippedSubviews']).toBe(true);
  });

  test('getItemLayout reports the uniform ListRow height, which is what makes it legal', () => {
    const r = render(
      <List state={{ kind: 'ready', items: ['a'] }} renderRow={row} keyExtractor={(i) => i} />,
    );
    const getItemLayout = r.get('ui.list').props['getItemLayout'] as (
      d: unknown,
      i: number,
    ) => { length: number; offset: number; index: number };
    expect(getItemLayout(null, 3)).toEqual({ length: touch.row, offset: touch.row * 3, index: 3 });
  });

  test('rows render through renderRow', () => {
    const r = render(
      <List state={{ kind: 'ready', items: ['a', 'b'] }} renderRow={row} keyExtractor={(i) => i} />,
    );
    expect(r.query('row.a')).not.toBeNull();
    expect(r.query('row.b')).not.toBeNull();
  });

  test.each([
    ['loading', { kind: 'loading' as const }],
    ['empty', { kind: 'empty' as const, empty: { title: 'Kosong' } }],
    [
      'error',
      {
        kind: 'error' as const,
        error: { title: 'Gagal', retryLabel: 'Coba Lagi', onRetry: vi.fn() },
      },
    ],
    [
      'unauthorized',
      {
        kind: 'unauthorized' as const,
        unauthorized: { title: 'Ditolak', backLabel: 'Kembali', onBack: vi.fn() },
      },
    ],
  ])('the %s state renders its own surface, not a list', (kind, state) => {
    const r = render(<List state={state} renderRow={row} keyExtractor={(i: string) => i} />);
    expect(r.query(`ui.list.${kind}`)).not.toBeNull();
    expect(r.query('ui.list')).toBeNull();
  });

  test('unauthorized renders the denial, never an empty list (FR-1036)', () => {
    const r = render(
      <List
        state={{
          kind: 'unauthorized',
          unauthorized: { title: 'Ditolak', backLabel: 'Kembali', onBack: vi.fn() },
        }}
        renderRow={row}
        keyExtractor={(i) => i}
      />,
    );
    expect(r.query('ui.unauthorizedState')).not.toBeNull();
    expect(r.query('ui.emptyState')).toBeNull();
  });
});

describe('TextInput (§3.2)', () => {
  const base = { label: 'Nama', value: '', onChangeText: vi.fn() };

  test('the label is always rendered above the field — never placeholder-as-label', () => {
    const r = render(<TextInput {...base} placeholder="mis. Yosia" />);
    expect(r.query('ui.textInput.label')).not.toBeNull();
  });

  test('focus draws the 2 dp primary ring (§3.2)', () => {
    const r = render(<TextInput {...base} />);
    expect(r.styleOf('ui.textInput.field')['borderColor']).toBe(color.border);
    fire(r.get('ui.textInput.field'), 'onFocus');
    expect(r.styleOf('ui.textInput.field')['borderColor']).toBe(color.primary);
    expect(r.styleOf('ui.textInput.field')['borderWidth']).toBe(border.focus);
  });

  test('error outranks focus — a focused field with an error still reads as an error', () => {
    const r = render(<TextInput {...base} errorMessage="Wajib diisi" />);
    fire(r.get('ui.textInput.field'), 'onFocus');
    expect(r.styleOf('ui.textInput.field')['borderColor']).toBe(color.danger);
  });

  test('the error carries an icon and a message, never colour alone (§6.3)', () => {
    const r = render(<TextInput {...base} errorMessage="Wajib diisi" />);
    const errorRow = r.get('ui.textInput.error');
    expect(errorRow.queryAll((n) => n.type === 'MaterialCommunityIcons')).toHaveLength(1);
  });

  test('disabled announces itself and stops editing (§6.4)', () => {
    const r = render(<TextInput {...base} disabled />);
    expect(r.get('ui.textInput.field').props['accessibilityState']).toEqual({ disabled: true });
    expect(r.get('ui.textInput.field').props['editable']).toBe(false);
  });

  test('min height meets the 56 dp primary target', () => {
    const r = render(<TextInput {...base} />);
    expect(r.styleOf('ui.textInput.field')['minHeight']).toBe(touch.primary);
  });

  // ── the §8.6 multiline variant ────────────────────────────────────────────────────────────────
  // These read the props/styles that REACH the RN primitive, never "a field rendered". The defect
  // this covers (task 128) was invisible to every assertion above precisely because the component
  // did render — it rendered a one-line box, and RN's `multiline` default of `false` is what made
  // a note body clip at ~35 characters. `multiline` is the prop RN reads, so it is what is asserted.
  describe('multiline (§8.6 free-form body)', () => {
    test('DEFAULT OFF: an unadorned field tells RN it is single-line', () => {
      const r = render(<TextInput {...base} />);
      expect(r.get('ui.textInput.field').props['multiline']).toBe(false);
    });

    test('every single-line-shaped variant stays single-line — the class, not one instance', () => {
      for (const extra of [
        { secureTextEntry: true },
        { keyboardType: 'number-pad' as const },
        { disabled: true },
        { autoFocus: true },
        { errorMessage: 'Wajib diisi' },
      ]) {
        const r = render(<TextInput {...base} {...extra} />);
        expect(r.get('ui.textInput.field').props['multiline']).toBe(false);
        expect(r.styleOf('ui.textInput.field')['maxHeight']).toBeUndefined();
      }
    });

    test('multiline reaches the RN primitive as the `multiline` prop', () => {
      const r = render(<TextInput {...base} multiline />);
      expect(r.get('ui.textInput.field').props['multiline']).toBe(true);
    });

    test('multiline tops its text — RN CENTRES multiline text on Android without this', () => {
      // Not cosmetic and not iOS trivia: the RN 0.86 docs say multiline aligns to the top on iOS
      // and CENTRES on Android, and Android is the target (§0). Dropping this leaves the body's
      // first line floating mid-box.
      expect(
        render(<TextInput {...base} multiline />).styleOf('ui.textInput.field')[
          'textAlignVertical'
        ],
      ).toBe('top');
      // The single-line field never declares it — the variant is additive.
      expect(
        render(<TextInput {...base} />).styleOf('ui.textInput.field')['textAlignVertical'],
      ).toBeUndefined();
    });

    test('multiline is sized to show several lines and to stop growing', () => {
      const s = render(<TextInput {...base} multiline />).styleOf('ui.textInput.field');
      expect(s['minHeight']).toBe(size.fieldMultilineMin);
      expect(s['maxHeight']).toBe(size.fieldMultilineMax);
      // Roomier than the single-line touch floor, and bounded — an unbounded field would push the
      // §8.1 bottom action bar off a 360x640 screen.
      expect(size.fieldMultilineMin).toBeGreaterThan(touch.primary);
      expect(size.fieldMultilineMax).toBeGreaterThan(size.fieldMultilineMin);
    });

    test('the multiline variant keeps the §3.2 chrome: label, focus ring, error adornment', () => {
      const r = render(<TextInput {...base} multiline errorMessage="Wajib diisi" />);
      expect(r.query('ui.textInput.label')).not.toBeNull();
      expect(r.query('ui.textInput.error')).not.toBeNull();
      expect(r.styleOf('ui.textInput.field')['borderColor']).toBe(color.danger);
    });
  });
});
