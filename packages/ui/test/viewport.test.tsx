// Width classes decide phone or tablet layouts by the room on screen, never by device type.
import { StyleSheet, Text } from 'react-native';
import { describe, expect, test } from 'vitest';

import { AppShell } from '../src/shell/AppShell.js';
import { size } from '../src/tokens.js';
import { widthClassOf } from '../src/viewport.js';
import { render } from './render.js';

describe('widthClassOf', () => {
  test.each([
    [360, 'compact'],
    [599, 'compact'],
    [600, 'medium'],
    [839, 'medium'],
    [840, 'expanded'],
    [1280, 'expanded'],
  ] as const)('%d dp is %s', (width, widthClass) => {
    expect(widthClassOf(width)).toBe(widthClass);
  });
});

describe('AppShell on a tablet', () => {
  /** The widest of the given node's ancestors' or own declared max widths. */
  function maxWidthAbove(
    node: { props: Record<string, unknown>; parent: unknown } | null,
  ): unknown {
    for (let at = node; at !== null; at = at.parent as typeof node) {
      const style = StyleSheet.flatten(at.props['style'] as never) as { maxWidth?: number } | null;
      if (style?.maxWidth !== undefined) return style.maxWidth;
    }
    return undefined;
  }

  test.each([false, true])(
    'content and the bottom action stop at a readable width (scrollable: %s)',
    (scrollable) => {
      const screen = render(
        <AppShell
          title="t"
          syncChip={null}
          avatar={null}
          scrollable={scrollable}
          bottomAction={<Text testID="action">a</Text>}
        >
          <Text testID="body">b</Text>
        </AppShell>,
      );
      expect(maxWidthAbove(screen.get('body') as never)).toBe(size.contentMax);
      expect(maxWidthAbove(screen.get('action') as never)).toBe(size.contentMax);
      // The header spans the screen, as app bars do.
      expect(maxWidthAbove(screen.get('ui.appShell.title') as never)).toBeUndefined();
    },
  );
});
