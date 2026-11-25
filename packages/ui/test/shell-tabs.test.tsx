// The place tabs live inside the screen's shell: one dock with its action, under its overlays.
import { act } from 'react';
import { Keyboard, Text } from 'react-native';
import { expect, test } from 'vitest';

import { AppShell } from '../src/shell/AppShell.js';
import { ShellTabsProvider } from '../src/shell/shell-tabs.js';
import { windowLayout } from './doubles/react-native.js';
import { render } from './render.js';

function isInside(node: { parent: unknown } | null, testID: string): boolean {
  for (let at = node as { parent: unknown; props?: Record<string, unknown> } | null; at;) {
    if (at.props?.['testID'] === testID) return true;
    at = at.parent as typeof at;
  }
  return false;
}

function screen(tabs: boolean, action: boolean, nested = false) {
  const inner = (
    <AppShell title="inner" syncChip={null} avatar={null} testID="inner">
      <Text>i</Text>
    </AppShell>
  );
  return render(
    <ShellTabsProvider tabs={tabs ? <Text testID="tabs">t</Text> : null}>
      <AppShell
        title="t"
        syncChip={null}
        avatar={null}
        bottomAction={action ? <Text testID="action">a</Text> : undefined}
        overlay={<Text testID="sheet">s</Text>}
      >
        {nested ? inner : <Text>b</Text>}
      </AppShell>
    </ShellTabsProvider>,
  );
}

test('the tabs share the bottom dock with the action, under it, with one rule above both', () => {
  const r = screen(true, true);
  expect(isInside(r.get('tabs') as never, 'ui.appShell.dock')).toBe(true);
  expect(isInside(r.get('action') as never, 'ui.appShell.dock')).toBe(true);
  expect(r.styleOf('ui.appShell.dock')['borderTopWidth']).toBeGreaterThan(0);
  expect(r.styleOf('ui.appShell.actionBar')['borderTopWidth']).toBeUndefined();
  // The overlay paints after the dock, so a sheet's scrim covers the tabs.
  const kids = r.get('ui.appShell').children as { props: Record<string, unknown> }[];
  const ids = kids.map((kid) => kid.props['testID']);
  expect(ids.indexOf('sheet')).toBeGreaterThan(ids.indexOf('ui.appShell.dock'));
});

test('a screen without tabs or an action has no dock', () => {
  expect(screen(false, false).query('ui.appShell.dock')).toBeNull();
  expect(screen(true, false).query('tabs')).not.toBeNull();
});

test('only the outer shell draws the tabs', () => {
  const r = screen(true, false, true);
  expect(r.all('tabs')).toHaveLength(1);
  expect(r.query('inner.dock')).toBeNull();
});

test('the tabs step aside while the keyboard is up', () => {
  windowLayout.set('ui.appShell', { y: 24, height: 820 });
  const r = screen(true, true);
  act(() => Keyboard.emit('keyboardDidShow', { endCoordinates: { screenY: 544 } }));
  expect(r.query('tabs')).toBeNull();
  expect(r.query('action')).not.toBeNull();
  act(() => Keyboard.emit('keyboardDidHide'));
  expect(r.query('tabs')).not.toBeNull();
  r.unmount();
  windowLayout.delete('ui.appShell');
});
