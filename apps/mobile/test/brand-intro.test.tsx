// The opening cover over the native splash. Its job is to never leave a blank or stuck screen: it
// covers until the app is ready, hides the native splash exactly once, and then gets out of the way.
// The double lands animations at once, so "gets out of the way" is read as "is gone".
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { BrandIntro } from '../src/bootstrap/BrandIntro.js';
import { render } from '../../../packages/ui/test/render.js';
import { __setReduceMotion } from '../../../packages/ui/test/doubles/react-native.js';

afterEach(() => act(() => __setReduceMotion(false)));

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

  test('goes away once the app is ready', () => {
    const r = render(<BrandIntro ready={false} />);
    r.rerender(<BrandIntro ready />);
    expect(r.query('brand-intro')).toBeNull();
  });

  test('stays gone if readiness flickers back', () => {
    const r = render(<BrandIntro ready />);
    r.rerender(<BrandIntro ready={false} />);
    expect(r.query('brand-intro')).toBeNull();
  });

  test('with reduce motion on, goes as soon as the app is ready', () => {
    act(() => __setReduceMotion(true));
    const r = render(<BrandIntro ready={false} />);
    r.rerender(<BrandIntro ready />);
    expect(r.query('brand-intro')).toBeNull();
  });
});
