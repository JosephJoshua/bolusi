// The opening cover over the native splash. Its job is to never leave a blank or stuck screen: it
// covers until the app is ready, hides the native splash exactly once, and then gets out of the way.
// The double lands animations at once, so "gets out of the way" is read as "is gone".
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { BrandIntro } from '../src/bootstrap/BrandIntro.js';
import { render } from '../../../packages/ui/test/render.js';
import { __setReduceMotion } from '../../../packages/ui/test/doubles/react-native.js';

// The hop starts from a timer once the splash has gone: time is driven by hand.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  act(() => __setReduceMotion(false));
  vi.useRealTimers();
});

describe('BrandIntro', () => {
  test('covers the screen and blocks touches while the app is not ready', () => {
    const r = render(<BrandIntro ready={false} />);
    expect(r.get('brand-intro').props['pointerEvents']).toBe('auto');
  });

  test('hides the native splash once, after the cover is drawn', () => {
    const onCovered = vi.fn();
    const r = render(<BrandIntro ready={false} onCovered={onCovered} />);
    expect(onCovered).not.toHaveBeenCalled();
    const layout = r.get('brand-intro').props['onLayout'] as () => void;
    act(() => layout());
    act(() => layout());
    expect(onCovered).toHaveBeenCalledOnce();
  });

  /** The cover is laid out, the splash goes, and the hop gets going. */
  const draw = (r: ReturnType<typeof render>): void => {
    const layout = r.get('brand-intro').props['onLayout'] as () => void;
    act(() => layout());
    act(() => vi.advanceTimersByTime(200));
  };

  test('tells the app to start loading only once the hop is running', () => {
    const onPlaying = vi.fn();
    const r = render(<BrandIntro ready={false} onPlaying={onPlaying} />);
    act(() => (r.get('brand-intro').props['onLayout'] as () => void)());
    expect(onPlaying).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(onPlaying).toHaveBeenCalledOnce();
  });

  test('with reduce motion on, the app may load at once', () => {
    act(() => __setReduceMotion(true));
    const onPlaying = vi.fn();
    const r = render(<BrandIntro ready={false} onPlaying={onPlaying} />);
    act(() => (r.get('brand-intro').props['onLayout'] as () => void)());
    expect(onPlaying).toHaveBeenCalledOnce();
  });

  test('the disc hops while the app loads, then the cover goes once the app is ready', () => {
    const r = render(<BrandIntro ready={false} />);
    draw(r);
    // The hop has played (the double lands it at once), and the cover still waits for the app.
    expect(r.query('brand-intro')).not.toBeNull();
    r.rerender(<BrandIntro ready />);
    expect(r.query('brand-intro')).toBeNull();
  });

  test('a cover that never drew still leaves soon after the app is ready', () => {
    const r = render(<BrandIntro ready />);
    expect(r.query('brand-intro')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_000));
    expect(r.query('brand-intro')).toBeNull();
  });

  test('stays gone if readiness flickers back', () => {
    const r = render(<BrandIntro ready />);
    draw(r);
    r.rerender(<BrandIntro ready={false} />);
    expect(r.query('brand-intro')).toBeNull();
  });

  test('with reduce motion on, goes as soon as the app is ready', () => {
    act(() => __setReduceMotion(true));
    const r = render(<BrandIntro ready={false} />);
    draw(r);
    r.rerender(<BrandIntro ready />);
    expect(r.query('brand-intro')).toBeNull();
  });

  describe('when the app is ready before the system says whether to reduce motion', () => {
    async function fresh() {
      vi.resetModules();
      const double = await import('../../../packages/ui/test/doubles/react-native.js');
      double.__holdReduceMotionAnswer();
      const { BrandIntro: Fresh } = await import('../src/bootstrap/BrandIntro.js');
      const harness = await import('../../../packages/ui/test/render.js');
      return { double, Fresh, harness };
    }

    test('waits under the cover for the answer, then plays and goes', async () => {
      const { double, Fresh, harness } = await fresh();
      const r = harness.render(<Fresh ready />);
      act(() => (r.get('brand-intro').props['onLayout'] as () => void)());
      expect(r.query('brand-intro')).not.toBeNull();
      await act(async () => {
        double.__answerReduceMotion(false);
        await Promise.resolve();
      });
      act(() => vi.advanceTimersByTime(200));
      expect(r.query('brand-intro')).toBeNull();
    });

    test('never waits long: with no answer it goes after a moment', async () => {
      const { Fresh, harness } = await fresh();
      const r = harness.render(<Fresh ready />);
      act(() => (r.get('brand-intro').props['onLayout'] as () => void)());
      expect(r.query('brand-intro')).not.toBeNull();
      act(() => vi.advanceTimersByTime(400));
      expect(r.query('brand-intro')).toBeNull();
    });
  });
});
