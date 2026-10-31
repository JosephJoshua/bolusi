/**
 * What a colleague just changed glows once: while it is on screen or as the change brings it in,
 * never for a row that mounts well after the change, and never in a catch-up burst (a new phone's
 * first sync).
 */
import { act } from 'react';
import { afterEach, describe, expect, test } from 'vitest';

import { Card } from '../src/components/Card.js';
import { FreshGlow } from '../src/components/FreshGlow.js';
import { ListRow } from '../src/components/ListRow.js';
import { markFresh, resetFresh } from '../src/fresh.js';
import { __setReduceMotion } from './doubles/react-native.js';
import { render } from './render.js';

afterEach(() => {
  resetFresh();
  act(() => __setReduceMotion(false));
});

// Marks are stamped later than the mount, as a real change arriving after the screen opened is.
const later = (): number => Date.now() + 5;

describe('FreshGlow', () => {
  test('nothing at rest; a change from another device glows, then fades to nothing', () => {
    const r = render(<FreshGlow id="t1" testID="glow" />);
    expect(r.query('glow')).toBeNull();
    act(() => markFresh('t1', later()));
    // The double lands the fade at once: it ends fully faded.
    expect((r.styleOf('glow')['opacity'] as { value: number }).value).toBe(0);
    expect(r.get('glow').props['pointerEvents']).toBe('none');
  });

  test('another record changing does not glow this one', () => {
    const r = render(<FreshGlow id="t1" testID="glow" />);
    act(() => markFresh('t2', later()));
    expect(r.query('glow')).toBeNull();
  });

  test('a row the change brings in (a new Kas entry on top) glows as it arrives', () => {
    act(() => markFresh('t1', Date.now() - 100));
    const r = render(<FreshGlow id="t1" testID="glow" />);
    expect(r.query('glow')).not.toBeNull();
  });

  test('a row that mounts well after the change, as a screen opens, stays calm', () => {
    act(() => markFresh('t1', Date.now() - 2_000));
    const r = render(<FreshGlow id="t1" testID="glow" />);
    expect(r.query('glow')).toBeNull();
  });

  test('a burst of changes (a first sync, back online) glows nothing', () => {
    const r = render(<FreshGlow id="t1" testID="glow" />);
    const at = later();
    act(() => {
      for (let i = 0; i < 20; i += 1) markFresh(`other-${String(i)}`, at);
      markFresh('t1', at);
    });
    expect(r.query('glow')).toBeNull();
  });

  test('with reduce motion on, nothing glows', () => {
    act(() => __setReduceMotion(true));
    const r = render(<FreshGlow id="t1" testID="glow" />);
    act(() => markFresh('t1', later()));
    expect(r.query('glow')).toBeNull();
  });
});

test('shared rows and cards glow by the id they are given', () => {
  const r = render(
    <>
      <ListRow primaryText="Ester" freshId="t1" testID="row" />
      <Card freshId="t2" testID="card">
        {null}
      </Card>
    </>,
  );
  act(() => {
    markFresh('t1', later());
    markFresh('t2', later());
  });
  expect(r.query('row.fresh')).not.toBeNull();
  expect(r.query('card.fresh')).not.toBeNull();
});
