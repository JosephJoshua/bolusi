/**
 * The §6 accessibility floor, asserted across the whole inventory rather than per component — so a
 * new component cannot quietly opt out.
 *
 * HONEST LIMIT: these read STYLE values, never measured frames. There is no Yoga layout in this
 * lane (see `doubles/react-native.tsx`), so "≥ 48 dp" here means "declares ≥ 48 dp or compensating
 * hitSlop". Real hit geometry, font scaling and native a11y bridging belong to the on-device suite
 * (testing-guide §2.6, L6).
 */
import { describe, expect, test, vi } from 'vitest';

import { AppShell } from '../src/shell/AppShell.js';
import { AvatarButton } from '../src/shell/AvatarButton.js';
import { SyncChip, type SyncChipState } from '../src/shell/SyncChip.js';
import { Button } from '../src/components/Button.js';
import { Card } from '../src/components/Card.js';
import { Chip } from '../src/components/Chip.js';
import { ConfirmSheet } from '../src/components/ConfirmSheet.js';
import { ListRow } from '../src/components/ListRow.js';
import { color, touch } from '../src/tokens.js';
import { render, type RenderResult } from './render.js';

const SYNC_STATES: readonly SyncChipState[] = [
  'synced',
  'pending',
  'syncing',
  'offline',
  'attention',
];

/** Effective touch extent of a node: its own dimension plus any compensating hitSlop (§1.4). */
function extent(r: RenderResult, testID: string, axis: 'height' | 'width'): number {
  const style = r.styleOf(testID);
  const node = r.get(testID);
  const slop = (node.props['hitSlop'] ?? {}) as Record<string, number | undefined>;
  const base =
    (style[axis] as number | undefined) ??
    (style[axis === 'height' ? 'minHeight' : 'minWidth'] as number | undefined) ??
    0;
  const pad =
    axis === 'height'
      ? (slop['top'] ?? 0) + (slop['bottom'] ?? 0)
      : (slop['left'] ?? 0) + (slop['right'] ?? 0);
  return base + pad;
}

describe('touch targets (§1.4, §6.2)', () => {
  test('Button is 56 dp — the primary target', () => {
    const r = render(<Button testID="b" label="x" onPress={vi.fn()} />);
    expect(extent(r, 'b', 'height')).toBe(touch.primary);
  });

  test('ListRow meets the 56 dp row minimum', () => {
    const r = render(<ListRow testID="row" primaryText="x" onPress={vi.fn()} />);
    expect(extent(r, 'row', 'height')).toBeGreaterThanOrEqual(touch.rowMin);
  });

  test('a tappable Chip below 48 dp compensates with hitSlop', () => {
    const r = render(<Chip testID="c" label="x" icon="pending" onPress={vi.fn()} />);
    // The visual really is smaller than the floor — otherwise this test proves nothing.
    expect(r.styleOf('c')['height']).toBeLessThan(touch.min);
    expect(extent(r, 'c', 'height')).toBeGreaterThanOrEqual(touch.min);
  });

  test.each(SYNC_STATES)('SyncChip (%s) meets the 48 dp floor', (state) => {
    const r = render(<SyncChip state={state} accessibilityLabel="sinkron" onPress={vi.fn()} />);
    expect(extent(r, 'ui.syncChip', 'height')).toBeGreaterThanOrEqual(touch.min);
    expect(extent(r, 'ui.syncChip', 'width')).toBeGreaterThanOrEqual(touch.min);
  });

  test('AvatarButton meets the 48 dp floor', () => {
    const r = render(
      <AvatarButton userId="u" initials="SW" accessibilityLabel="ganti" onPress={vi.fn()} />,
    );
    expect(extent(r, 'ui.avatarButton', 'height')).toBeGreaterThanOrEqual(touch.min);
  });

  test('the AppShell back control meets the 48 dp floor', () => {
    const r = render(
      <AppShell title="x" backLabel="Kembali" onBack={vi.fn()} syncChip={null} avatar={null}>
        {null}
      </AppShell>,
    );
    expect(extent(r, 'ui.appShell.back', 'height')).toBeGreaterThanOrEqual(touch.min);
  });
});

describe('roles and states (§6.4)', () => {
  test.each([
    ['Button', <Button testID="t" label="x" onPress={vi.fn()} />],
    ['tappable Chip', <Chip testID="t" label="x" icon="pending" onPress={vi.fn()} />],
    ['tappable ListRow', <ListRow testID="t" primaryText="x" onPress={vi.fn()} />],
    [
      'tappable Card',
      <Card testID="t" accessibilityLabel="x" onPress={vi.fn()}>
        {null}
      </Card>,
    ],
    ['SyncChip', <SyncChip testID="t" state="synced" accessibilityLabel="x" onPress={vi.fn()} />],
    [
      'AvatarButton',
      <AvatarButton testID="t" userId="u" initials="SW" accessibilityLabel="x" onPress={vi.fn()} />,
    ],
  ])('%s sets accessibilityRole=button', (_name, element) => {
    const r = render(element);
    expect(r.get('t').props['accessibilityRole']).toBe('button');
  });

  test.each([
    ['Button', <Button testID="t" label="x" onPress={vi.fn()} />],
    ['tappable Chip', <Chip testID="t" label="x" icon="pending" onPress={vi.fn()} />],
    ['SyncChip', <SyncChip testID="t" state="offline" accessibilityLabel="x" onPress={vi.fn()} />],
  ])('%s carries an accessibilityLabel', (_name, element) => {
    const r = render(element);
    expect(typeof r.get('t').props['accessibilityLabel']).toBe('string');
  });

  test('a non-tappable Chip is not announced as a button', () => {
    const r = render(<Chip testID="t" label="x" icon="pending" />);
    expect(r.get('t').props['accessibilityRole']).toBeUndefined();
  });
});

describe('no colour-only signalling (§6.3)', () => {
  test.each(SYNC_STATES)('SyncChip (%s) carries an icon, not just a tint', (state) => {
    const r = render(<SyncChip state={state} accessibilityLabel="x" onPress={vi.fn()} />);
    expect(r.query(`ui.syncChip.icon.${state}`)).not.toBeNull();
  });

  test('SyncChip attention adds a dot on top of the icon — a second non-colour channel', () => {
    const r = render(<SyncChip state="attention" accessibilityLabel="x" onPress={vi.fn()} />);
    expect(r.query('ui.syncChip.dot')).not.toBeNull();
  });

  test('offline is neutral, never red — offline is a normal operating mode (§4.6)', () => {
    const r = render(<SyncChip state="offline" accessibilityLabel="x" onPress={vi.fn()} />);
    const icon = r.get('ui.syncChip.icon.offline');
    expect(icon.props['color']).toBe(color.textMuted);
    expect(icon.props['color']).not.toBe(color.danger);
  });

  test('every Chip tone renders an icon sibling alongside its label', () => {
    for (const tone of ['neutral', 'warning', 'danger', 'success'] as const) {
      const r = render(<Chip testID="t" label="x" icon="pending" tone={tone} />);
      expect(r.get('t').queryAll((n) => n.type === 'MaterialCommunityIcons')).toHaveLength(1);
      expect(r.query('t.label')).not.toBeNull();
    }
  });
});

describe('ConfirmSheet (§3.10)', () => {
  test('cancel sits BELOW confirm — the thumb rests at the bottom, so the safe action gets it', () => {
    const r = render(
      <ConfirmSheet
        title="Arsipkan?"
        confirmLabel="Ya, Lanjutkan"
        onConfirm={vi.fn()}
        cancelLabel="Batal"
        onCancel={vi.fn()}
      />,
    );
    const order = r.container
      .queryAll(
        (n) =>
          n.props['testID'] === 'ui.confirmSheet.confirm' ||
          n.props['testID'] === 'ui.confirmSheet.cancel',
      )
      .map((n) => n.props['testID']);
    expect(order).toEqual(['ui.confirmSheet.confirm', 'ui.confirmSheet.cancel']);
  });

  test('the destructive action uses the destructive variant, and cancel does not', () => {
    const r = render(
      <ConfirmSheet
        title="x"
        confirmLabel="y"
        onConfirm={vi.fn()}
        cancelLabel="z"
        onCancel={vi.fn()}
      />,
    );
    expect(r.styleOf('ui.confirmSheet.confirm')['backgroundColor']).toBe(color.danger);
    expect(r.styleOf('ui.confirmSheet.cancel')['backgroundColor']).toBe(color.surface);
  });

  test('both sheet buttons meet the primary target height', () => {
    const r = render(
      <ConfirmSheet
        title="x"
        confirmLabel="y"
        onConfirm={vi.fn()}
        cancelLabel="z"
        onCancel={vi.fn()}
      />,
    );
    expect(r.styleOf('ui.confirmSheet.confirm')['height']).toBe(touch.primary);
    expect(r.styleOf('ui.confirmSheet.cancel')['height']).toBe(touch.primary);
  });
});
