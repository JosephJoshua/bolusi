/**
 * Guards for the two ways a control can render perfectly and still be unusable on a real phone
 * (tasks 205, 206). Both defects were invisible to every existing test: the node is present and
 * "visible" in the hierarchy, so a prop-level assertion passes, and Maestro taps by BOUNDS so even
 * the green emulator lane could not disprove them. The assertions below are therefore about
 * GEOMETRY — what the layout actually reserves — not about presence.
 */
import { act } from 'react';
import { Keyboard } from 'react-native';
import { expect, test } from 'vitest';

import { AppShell } from '../src/shell/AppShell.js';
import { ConfirmSheet } from '../src/components/ConfirmSheet.js';
import { NAV_BAR_INSET } from '../src/platform-insets.js';
import { space } from '../src/tokens.js';
import { windowLayout } from './doubles/react-native.js';
import { render } from './render.js';

function sheet() {
  return render(
    <ConfirmSheet
      title="t"
      confirmLabel="c"
      onConfirm={() => {}}
      cancelLabel="x"
      onCancel={() => {}}
    />,
  );
}

function shell(scrollable = false) {
  return render(
    <AppShell title="t" syncChip={null} avatar={null} scrollable={scrollable}>
      {null}
    </AppShell>,
  );
}

// ── task 205: the ConfirmSheet escapes the app shell, so it must inset itself ────────────────────

test('the confirm sheet reserves the nav-bar height below its last action', () => {
  // Cancel is deliberately the sheet's LAST child (thumb-misfire safety, §3.10), which puts the
  // SAFE action nearest the nav bar. The sheet is an absolute overlay mounted outside the shell, so
  // it inherits none of the shell's bottom padding and has to reserve that band itself.
  const style = sheet().styleOf('ui.confirmSheet.sheet');
  expect(style['paddingBottom']).toBe(space.lg + NAV_BAR_INSET);
});

test('the confirm sheet pads its bottom strictly more than its top', () => {
  // The relationship, not the number: whatever the token values become, the docked edge must always
  // reserve more than the free edge, or the nav bar is eating part of a control again.
  // The top comes from the `padding` shorthand (there is no explicit `paddingTop`), so resolve it
  // the way RN does — longhand wins, shorthand is the fallback.
  const style = sheet().styleOf('ui.confirmSheet.sheet');
  const top = Number(style['paddingTop'] ?? style['padding']);
  expect(Number.isNaN(top)).toBe(false); // a NaN here would make the comparison vacuous
  expect(Number(style['paddingBottom'])).toBeGreaterThan(top);
});

test('the nav-bar inset is a positive height on Android', () => {
  // A denominator check (T-14): if this were 0, both assertions above would still "pass" while
  // reserving nothing at all.
  expect(NAV_BAR_INSET).toBeGreaterThan(0);
});

// ── task 206: the shell content slot must be reachable when it overflows ─────────────────────────

test('the shell content slot does NOT scroll unless the screen opts in', () => {
  // Opt-in, not default (task 206 + the PR-5 correctness review). 5 of 13 AppShell screens render a
  // `List` (a FlatList); nesting a same-orientation VirtualizedList inside a plain ScrollView breaks
  // RN windowing. Defaulting to a ScrollView silently did that to all seven.
  expect(shell().get('ui.appShell.content').type).toBe('View');
});

test('the shell content slot scrolls when the screen opts in', () => {
  expect(shell(true).get('ui.appShell.content').type).toBe('ScrollView');
});

test('the content keeps the same testID whichever shape it took', () => {
  // Navigation and the Maestro flows address this slot by testID; the opt-in must not move it.
  expect(shell().query('ui.appShell.content')).not.toBeNull();
  expect(shell(true).query('ui.appShell.content')).not.toBeNull();
});

test('the scrolling content container grows without being clamped to the viewport', () => {
  // `flex: 1` on a scroll content container clamps it to the viewport and silently restores the
  // clipping this task exists to remove — so the absence of `flex` is the real assertion here.
  const container = shell(true).get('ui.appShell.content').props['contentContainerStyle'] as Record<
    string,
    unknown
  >;
  expect(container['flexGrow']).toBe(1);
  expect(container['flex']).toBeUndefined();
});

test('the content keeps its padding in both shapes', () => {
  // Losing the padding in either branch would be a silent regression no other test covers.
  // Scrolling, it sits on the view inside the ScrollView, the one a focused field is measured
  // against when it is scrolled above the keyboard (shell/keyboard.tsx).
  expect(shell(true).styleOf('ui.appShell.contentInner')['padding']).toBe(space.lg);
  expect(shell().styleOf('ui.appShell.content')['padding']).toBe(space.lg);
});

// ── the on-screen keyboard: the shell lifts its bottom action clear of the keyboard's top edge ──

test('the shell is lifted by exactly how far the keyboard covers it, measured in the window', () => {
  // Regression (Android 16 emulator): KeyboardAvoidingView measured itself against its parent,
  // so under the status bar inset the bottom action stayed tucked under the keyboard's top edge.
  // The shell sits 24 dp down the window (below the status bar) and is 820 dp tall.
  windowLayout.set('ui.appShell', { y: 24, height: 820 });
  const r = shell(true);
  expect(r.styleOf('ui.appShell')['paddingBottom']).toBeUndefined();

  act(() => Keyboard.emit('keyboardDidShow', { endCoordinates: { screenY: 544 } }));
  expect(r.styleOf('ui.appShell')['paddingBottom']).toBe(24 + 820 - 544);

  act(() => Keyboard.emit('keyboardDidHide'));
  expect(r.styleOf('ui.appShell')['paddingBottom']).toBeUndefined();
  r.unmount();
  windowLayout.delete('ui.appShell');
});
