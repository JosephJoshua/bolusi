/**
 * Motion: every animation must END where the still layout is. A sheet stuck at opacity 0 or a
 * button left shrunk is a broken screen, not a style. The double lands animations at once, so these
 * read the end state; the curve itself is only visible on a device.
 */
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Button } from '../src/components/Button.js';
import { ConfirmSheet } from '../src/components/ConfirmSheet.js';
import { OutcomeState } from '../src/components/OutcomeState.js';
import { Sheet } from '../src/components/Sheet.js';
import { Toast } from '../src/components/Toast.js';
import { motion, overlayOpacity } from '../src/tokens.js';
import { __setReduceMotion } from './doubles/react-native.js';
import { fire, render } from './render.js';

type Live = { readonly value: number };
const valueOf = (style: unknown): number => (style as Live).value;

function transformOf(style: Record<string, unknown>, key: string): number {
  const entry = (style['transform'] as Record<string, unknown>[]).find((t) => key in t);
  return valueOf(entry?.[key]);
}

afterEach(() => act(() => __setReduceMotion(false)));

describe('entrances land on the still layout', () => {
  test('ConfirmSheet: scrim at the overlay opacity, sheet fully in place', () => {
    const r = render(
      <ConfirmSheet
        title="Batalkan servisan?"
        confirmLabel="Batalkan"
        cancelLabel="Kembali"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(valueOf(r.styleOf('ui.confirmSheet.scrim')['opacity'])).toBeCloseTo(overlayOpacity);
    const sheet = r.styleOf('ui.confirmSheet.sheet');
    expect(valueOf(sheet['opacity'])).toBe(1);
    expect(transformOf(sheet, 'translateY')).toBe(0);
  });

  test('Sheet: the sheet arrives and the scrim still closes it', () => {
    const onClose = vi.fn();
    const r = render(
      <Sheet title="Foto" closeLabel="Tutup" onClose={onClose}>
        {null}
      </Sheet>,
    );
    const sheet = r.styleOf('ui.sheet.sheet');
    expect(valueOf(sheet['opacity'])).toBe(1);
    expect(transformOf(sheet, 'translateY')).toBe(0);
    fire(r.get('ui.sheet.scrim'), 'onPress');
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('Toast rises fully into view', () => {
    const r = render(<Toast message="Tersinkron" onHide={vi.fn()} />);
    expect(valueOf(r.styleOf('ui.toast')['opacity'])).toBe(1);
  });

  test('OutcomeState disc lands at full size', () => {
    const r = render(<OutcomeState tone="success" icon="success" title="Selesai" />);
    const disc = r.container.queryAll((node) => node.type === 'Animated.View')[0]!;
    const style = disc.props['style'] as unknown[];
    const pop = style[style.length - 1] as Record<string, unknown>;
    expect(transformOf(pop, 'scale')).toBe(1);
    expect(valueOf(pop['opacity'])).toBe(1);
  });
});

describe('press feedback', () => {
  const scaleOf = (r: ReturnType<typeof render>): number => {
    const wrapper = r.container.queryAll((node) => node.type === 'Animated.View')[0]!;
    return transformOf(wrapper.props['style'] as Record<string, unknown>, 'scale');
  };

  test('a pressed button shrinks and springs back on release', () => {
    const r = render(<Button testID="b" label="Lanjut" onPress={vi.fn()} />);
    fire(r.get('b'), 'onPressIn');
    expect(scaleOf(r)).toBe(motion.pressScale);
    fire(r.get('b'), 'onPressOut');
    expect(scaleOf(r)).toBe(1);
  });

  test('a disabled button does not move', () => {
    const r = render(<Button testID="b" label="Lanjut" onPress={vi.fn()} disabled />);
    fire(r.get('b'), 'onPressIn');
    expect(scaleOf(r)).toBe(1);
  });

  test('with reduce motion on, a press does not shrink the button', () => {
    const r = render(<Button testID="b" label="Lanjut" onPress={vi.fn()} />);
    act(() => __setReduceMotion(true));
    fire(r.get('b'), 'onPressIn');
    expect(scaleOf(r)).toBe(1);
  });
});
