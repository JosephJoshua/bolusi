/**
 * Banner (design-system §3.6) — staleness mapping and the priority ladder.
 *
 * Note what is deliberately absent: any number of milliseconds. The input is the LEVEL NAME from
 * 03-state-machines §8; the thresholds live only there. If this file ever needs `3_600_000`, the
 * derivation has leaked into the wrong layer.
 */
import { describe, expect, test, vi } from 'vitest';

import {
  Banner,
  BANNER_MESSAGE_LINES,
  selectBanner,
  type BannerCause,
} from '../src/components/Banner.js';
import { FreshnessCell } from '../src/components/FreshnessCell.js';
import { color } from '../src/tokens.js';
import { render } from './render.js';

describe('staleness → banner mapping (§3.6; levels from 03-state-machines §8)', () => {
  test('fresh raises no banner — quiet is a feature', () => {
    expect(selectBanner([{ kind: 'staleness', level: 'fresh' }])).toBeNull();
  });

  test('warning maps to the warning variant', () => {
    expect(selectBanner([{ kind: 'staleness', level: 'warning' }])?.variant).toBe('warning');
  });

  test('stale maps to the danger variant', () => {
    expect(selectBanner([{ kind: 'staleness', level: 'stale' }])?.variant).toBe('danger');
  });

  test('conflict surfaced maps to warning', () => {
    expect(selectBanner([{ kind: 'conflictSurfaced' }])?.variant).toBe('warning');
  });

  test.each([['rejectedOps'], ['deviceRevoked'], ['userDeactivated']] as const)(
    '%s maps to danger',
    (kind) => {
      expect(selectBanner([{ kind } as BannerCause])?.variant).toBe('danger');
    },
  );

  test('no causes at all renders nothing', () => {
    expect(selectBanner([])).toBeNull();
  });

  test('a fresh level among real causes does not count toward the suppressed tally', () => {
    const selected = selectBanner([
      { kind: 'staleness', level: 'fresh' },
      { kind: 'conflictSurfaced' },
    ]);
    expect(selected?.suppressedCount).toBe(0);
  });
});

describe('priority ladder (§3.6) — exactly one banner, highest wins', () => {
  /** The six ranks, in the doc's order. Index = rank - 1. */
  const LADDER: readonly BannerCause[] = [
    { kind: 'deviceRevoked' },
    { kind: 'rejectedOps' },
    { kind: 'staleness', level: 'stale' },
    { kind: 'conflictSurfaced' },
    { kind: 'staleness', level: 'warning' },
    { kind: 'info', id: 'backfill-done' },
  ];

  // All 15 ordered pairs — the task asks for the ranks to be pairwise-tested, so they are
  // generated rather than trusted to a hand-written subset.
  const pairs = LADDER.flatMap((higher, i) =>
    LADDER.slice(i + 1).map((lower, j) => ({ higher, lower, hi: i + 1, lo: i + j + 2 })),
  );

  test('generates all 15 ordered pairs of the 6 ranks', () => {
    expect(pairs).toHaveLength(15);
  });

  test.each(pairs.map((p) => [`rank ${p.hi} beats rank ${p.lo}`, p] as const))('%s', (_name, p) => {
    expect(selectBanner([p.higher, p.lower])?.cause).toEqual(p.higher);
    // Order of the input must not decide the winner.
    expect(selectBanner([p.lower, p.higher])?.cause).toEqual(p.higher);
  });

  test('user deactivated shares rank 1 with device revoked and still beats rank 2', () => {
    expect(selectBanner([{ kind: 'rejectedOps' }, { kind: 'userDeactivated' }])?.cause).toEqual({
      kind: 'userDeactivated',
    });
  });

  test('the suppressed count is every other active cause', () => {
    const selected = selectBanner(LADDER);
    expect(selected?.cause).toEqual({ kind: 'deviceRevoked' });
    expect(selected?.suppressedCount).toBe(5);
  });

  test('a tie keeps the caller order, so a re-render cannot flip which one shows', () => {
    const a: BannerCause = { kind: 'deviceRevoked' };
    const b: BannerCause = { kind: 'userDeactivated' };
    expect(selectBanner([a, b])?.cause).toEqual(a);
    expect(selectBanner([a, b])?.cause).toEqual(a);
  });
});

describe('suppressed affix (§3.6)', () => {
  test('the +N affix renders when causes are suppressed and the banner is pressable', () => {
    const onPress = vi.fn();
    const r = render(<Banner variant="danger" message="x" suppressedCount={3} onPress={onPress} />);
    expect(r.query('ui.banner.affix')).not.toBeNull();
    expect(r.query('ui.banner.open')).not.toBeNull();
  });

  test('no affix when nothing is suppressed', () => {
    const r = render(<Banner variant="danger" message="x" suppressedCount={0} onPress={vi.fn()} />);
    expect(r.query('ui.banner.affix')).toBeNull();
  });
});

describe('dismiss matrix (§3.6) — enforced by the component, not trusted to callers', () => {
  test('danger exposes no dismiss affordance even when handlers are passed', () => {
    const r = render(
      <Banner variant="danger" message="x" onDismiss={vi.fn()} onToggleCollapse={vi.fn()} />,
    );
    expect(r.query('ui.banner.dismiss')).toBeNull();
    expect(r.query('ui.banner.collapse')).toBeNull();
  });

  test('warning exposes no dismiss — only collapse', () => {
    const r = render(
      <Banner variant="warning" message="x" onDismiss={vi.fn()} onToggleCollapse={vi.fn()} />,
    );
    expect(r.query('ui.banner.dismiss')).toBeNull();
    expect(r.query('ui.banner.collapse')).not.toBeNull();
  });

  test('info dismisses', () => {
    const r = render(<Banner variant="info" message="x" onDismiss={vi.fn()} />);
    expect(r.query('ui.banner.dismiss')).not.toBeNull();
  });

  test('a collapsed warning renders the header dot instead of the strip', () => {
    const r = render(<Banner variant="warning" message="x" collapsed onToggleCollapse={vi.fn()} />);
    expect(r.query('ui.banner.dot')).not.toBeNull();
    expect(r.query('ui.banner.message')).toBeNull();
  });

  test('the collapsed dot re-expands via its handler', () => {
    const onToggleCollapse = vi.fn();
    const r = render(
      <Banner variant="warning" message="x" collapsed onToggleCollapse={onToggleCollapse} />,
    );
    (r.get('ui.banner.dot').props['onPress'] as () => void)();
    expect(onToggleCollapse).toHaveBeenCalledOnce();
  });
});

describe('anatomy (§3.6)', () => {
  test('the message allows 3 lines — the real ID stale string needs them at 1.3x scale', () => {
    expect(BANNER_MESSAGE_LINES).toBe(3);
    const r = render(<Banner variant="danger" message="x" />);
    expect(r.get('ui.banner.message').props['numberOfLines']).toBe(3);
  });

  test('the staleness banner carries the FreshnessCell as its glyph (§3.11)', () => {
    const r = render(
      <Banner variant="danger" message="x" leadingGlyph={<FreshnessCell level="stale" />} />,
    );
    expect(r.query('ui.freshnessCell.stale')).not.toBeNull();
  });

  test('a banner announces itself as an alert (§6.4)', () => {
    const r = render(<Banner variant="warning" message="x" />);
    expect(r.get('ui.banner').props['accessibilityRole']).toBe('alert');
  });

  test.each([
    ['info', color.infoBg],
    ['warning', color.warningBg],
    ['danger', color.dangerBg],
  ] as const)('%s uses its contrast-validated tinted background', (variant, bg) => {
    const r = render(<Banner variant={variant} message="x" />);
    expect(r.styleOf('ui.banner')['backgroundColor']).toBe(bg);
  });
});
