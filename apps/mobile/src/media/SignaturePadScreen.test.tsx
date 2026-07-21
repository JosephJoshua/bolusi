// MOUNTED-RENDER tests for the signature pad (task 69's lane, design-system §5).
//
// Two things are being guarded, and the second is the one that would go wrong silently:
//   1. §5's four states, all four of which are REAL on this screen (an unsigned pad is a genuine
//      Empty, unlike a live viewfinder's).
//   2. THE INK REACHES THE SCREEN. `segmentsFor` can be perfect and the pad can still render
//      nothing — a dropped `.map`, a `position` that never became `absolute`, a responder that was
//      never wired. A customer signing an invisible pad is the failure nobody reports as a bug;
//      they just sign again, harder.
//
// The touch handlers are driven through the responder props the double passes through untouched, so
// a stroke is exercised without a touch screen (T-6). What this lane CANNOT answer is how the pad
// FEELS — latency, sample rate, palm rejection are device properties and there is no device here
// (D12/D13), on either platform.
import { color } from '@bolusi/ui';
import { t } from '@bolusi/i18n';
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { fire, render } from '../../../../packages/ui/test/render.js';

import { SignaturePadScreen, segmentsFor, type SignaturePadState } from './SignaturePadScreen.js';
import type { SignatureStroke } from './signature-png.js';

const STROKE: SignatureStroke = [
  { x: 10, y: 10 },
  { x: 60, y: 40 },
  { x: 120, y: 20 },
];

/**
 * The already-localized title the FLOW supplies (see the prop's doc: 06 has no capture-screen title
 * key and the catalog is a contended package this task may not extend). Hoisted out of the JSX
 * because it is inert fixture data, not copy — the same reason the shared config exempts
 * `packages/ui`'s own component tests from `bolusi/no-hardcoded-strings`.
 */
const TITLE = 'Tanda tangan pelanggan';

function renderPad(
  state: SignaturePadState,
  strokes: readonly SignatureStroke[] = [],
  handlers: Partial<Record<string, (...args: never[]) => void>> = {},
) {
  return render(
    <SignaturePadScreen
      title={TITLE}
      state={state}
      strokes={strokes}
      syncChip={<></>}
      avatar={<></>}
      onStrokeStart={(handlers['onStrokeStart'] as never) ?? vi.fn()}
      onStrokeMove={(handlers['onStrokeMove'] as never) ?? vi.fn()}
      onStrokeEnd={(handlers['onStrokeEnd'] as never) ?? vi.fn()}
      onClear={(handlers['onClear'] as never) ?? vi.fn()}
      onSave={(handlers['onSave'] as never) ?? vi.fn()}
      onRetry={(handlers['onRetry'] as never) ?? vi.fn()}
      onBack={(handlers['onBack'] as never) ?? vi.fn()}
    />,
  );
}

const READY: SignaturePadState = { kind: 'ready' };

afterEach(() => {
  vi.useRealTimers();
});

describe('design-system §5 — all four states, and all four are real here', () => {
  test('LOADING: while the caller resolves whether a signature already exists', () => {
    // Accepting strokes before that answer arrives could silently replace evidence — FR-819: a
    // media ref, once attached, can never be replaced.
    vi.useFakeTimers();
    const screen = renderPad({ kind: 'loading' });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.query('signature-loading')).not.toBeNull();
    expect(screen.query('signature-surface')).toBeNull();
    expect(screen.query('signature-save')).toBeNull();
  });

  test('EMPTY: an untouched pad shows the prompt, BEHIND the drawing surface', () => {
    const screen = renderPad(READY, []);
    expect(screen.query('signature-empty')).not.toBeNull();
    // The surface is still mounted and still first in the touch path — a prompt that had to be
    // dismissed would cost every customer their first stroke.
    expect(screen.query('signature-surface')).not.toBeNull();
    expect(screen.get('signature-surface').props['onStartShouldSetResponder']).toBeTypeOf(
      'function',
    );
  });

  test('EMPTY clears the moment there is ink', () => {
    const screen = renderPad(READY, [STROKE]);
    expect(screen.query('signature-empty')).toBeNull();
  });

  test('UNAUTHORIZED: a user who may not sign off gets a lock and a way back, not an empty pad', () => {
    const screen = renderPad({ kind: 'unauthorized' });
    expect(screen.get('signature-unauthorized.title').props['children']).toBe(
      t('core.errors.PERMISSION_DENIED'),
    );
    expect(screen.query('signature-unauthorized.back')).not.toBeNull();
    expect(screen.query('signature-surface')).toBeNull();
  });

  test('ERROR: a full disk refuses with 06 §7`s explicit dialog; a failure shows its code', () => {
    const refused = renderPad({ kind: 'refused_low_storage' });
    expect(refused.get('signature-refused.title').props['children']).toBe(
      t('media.capture.refusedTitle'),
    );
    expect(refused.query('signature-save')).toBeNull();

    const failed = renderPad({ kind: 'failed', code: 'WRITE_FAILED' });
    expect(failed.get('signature-failed.code').props['children']).toBe('WRITE_FAILED');
    expect(failed.get('signature-failed.retry').props['onPress']).toBeTypeOf('function');
  });
});

describe('THE INK REACHES THE SCREEN', () => {
  test('a stroke renders one segment per sample pair, positioned and rotated', () => {
    const screen = renderPad(READY, [STROKE]);
    const ink = screen.all('signature-ink');
    // Three samples ⇒ two joined segments. A dot-per-sample implementation would render three.
    expect(ink).toHaveLength(2);

    const first = screen.all('signature-ink')[0];
    const style = first?.props['style'];
    expect(Array.isArray(style)).toBe(true);
    const overrides = (style as Record<string, unknown>[])[1] ?? {};
    // The segment starts at the first sample, is offset by half the nib so the line is CENTRED on
    // the path (an uncentred line sits below the finger, which is what makes a pad feel broken),
    // and is rotated along the direction of travel.
    expect(overrides['left']).toBe(10);
    expect(overrides['top']).toBe(8);
    expect(overrides['width']).toBeGreaterThan(50);
    expect(String((overrides['transform'] as { rotate: string }[])[0]?.rotate)).toMatch(/deg$/);
    // §2.3's black stroke, from the token — not a literal. Read off the FIRST segment (`styleOf`
    // demands a unique testID and there are legitimately two here).
    const base = (style as Record<string, unknown>[])[0] ?? {};
    expect(base['backgroundColor']).toBe(color.text);
  });

  test('NEGATIVE CONTROL: an empty pad renders NO ink — so the count above is not incidental', () => {
    expect(renderPad(READY, []).all('signature-ink')).toHaveLength(0);
    expect(renderPad(READY, [[]]).all('signature-ink')).toHaveLength(0);
  });

  test('a single-point stroke still marks the pad (a tittle, a full stop)', () => {
    const screen = renderPad(READY, [[{ x: 40, y: 40 }]]);
    expect(screen.all('signature-ink')).toHaveLength(1);
    expect(segmentsFor([[{ x: 40, y: 40 }]])[0]).toEqual({
      left: 38,
      top: 38,
      width: 4,
      angle: 0,
    });
  });

  test('segments close their joints — consecutive strokes leave no hairline gaps', () => {
    // `Math.hypot(dx, dy) + INK_THICKNESS`: without the addend, every direction change in a curved
    // signature shows a one-pixel hole, and a signature is nothing but direction changes.
    const [segment] = segmentsFor([
      [
        { x: 0, y: 0 },
        { x: 30, y: 40 },
      ],
    ]);
    expect(segment?.width).toBe(54); // hypot(30,40) = 50, plus the 4 dp nib
    expect(segment?.angle).toBeCloseTo(53.13, 1);
  });
});

describe('the touch responder is wired to the caller`s stroke handlers', () => {
  test('grant / move / release / terminate all reach their handler', () => {
    const events: string[] = [];
    const screen = renderPad(READY, [], {
      onStrokeStart: () => events.push('start'),
      onStrokeMove: () => events.push('move'),
      onStrokeEnd: () => events.push('end'),
    });

    const surface = screen.get('signature-surface');
    expect(surface.props['onStartShouldSetResponder']()).toBe(true);
    fire(surface, 'onResponderGrant', { nativeEvent: { locationX: 5, locationY: 6 } });
    fire(surface, 'onResponderMove', { nativeEvent: { locationX: 9, locationY: 9 } });
    fire(surface, 'onResponderRelease');
    // A gesture taken away mid-stroke (an incoming call, a system dialog) must END the stroke —
    // otherwise the next touch is joined to the abandoned one by a line across the whole pad.
    fire(surface, 'onResponderTerminate');

    expect(events).toEqual(['start', 'move', 'end', 'end']);
  });

  test('the pad reports the touch COORDINATES it was given, unmodified', () => {
    const points: { x: number; y: number }[] = [];
    const screen = renderPad(READY, [], {
      onStrokeStart: ((point: { x: number; y: number }) => points.push(point)) as never,
    });
    fire(screen.get('signature-surface'), 'onResponderGrant', {
      nativeEvent: { locationX: 42, locationY: 17 },
    });
    expect(points).toEqual([{ x: 42, y: 17 }]);
  });

  test('while SAVING, the surface refuses the gesture — strokes cannot change the encoded bytes', () => {
    // The rasterise/encode/hash/move sequence reads `strokes`; a stroke landing mid-save would
    // produce a file that does not match the signature the customer watched themselves draw.
    const screen = renderPad({ kind: 'saving' }, [STROKE]);
    expect(screen.get('signature-surface').props['onStartShouldSetResponder']()).toBe(false);
  });
});

describe('the action bar', () => {
  test('an unsigned pad cannot be saved OR cleared — nothing to press is nothing to press', () => {
    // The disabled save is the UI half of `captureSignature`'s `refused_empty`; the rule is
    // enforced twice on purpose, because a blank white PNG is a valid file that would sit in the
    // record as an acknowledgement nobody gave.
    const screen = renderPad(READY, []);
    expect(screen.get('signature-save').props['disabled']).toBe(true);
    expect(screen.get('signature-save').props['onPress']).toBeUndefined();
    expect(screen.get('signature-clear').props['disabled']).toBe(true);
  });

  test('with ink, both are live, and the labels come from the catalog', () => {
    const onSave = vi.fn();
    const onClear = vi.fn();
    const screen = renderPad(READY, [STROKE], { onSave, onClear });

    const save = screen.get('signature-save');
    const clear = screen.get('signature-clear');
    expect(save.props['disabled']).toBe(false);
    expect(clear.props['disabled']).toBe(false);
    expect(save.props['accessibilityLabel']).toBe(t('core.action.save'));
    expect(clear.props['accessibilityLabel']).toBe(t('core.action.delete'));
    // §3.1: one primary fill, and the erase control is the secondary one.
    expect(screen.styleOf('signature-save')['backgroundColor']).toBe(color.primary);
    expect(screen.styleOf('signature-clear')['backgroundColor']).toBe(color.surface);

    fire(save, 'onPress');
    fire(clear, 'onPress');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  test('SAVING marks the primary busy and unwires both — a double-tap cannot make two signatures', () => {
    const screen = renderPad({ kind: 'saving' }, [STROKE]);
    expect(screen.get('signature-save').props['accessibilityState']).toEqual({
      disabled: true,
      busy: true,
    });
    expect(screen.get('signature-save').props['onPress']).toBeUndefined();
    expect(screen.get('signature-clear').props['onPress']).toBeUndefined();
  });
});
