// MOUNTED-RENDER tests for the capture surface (task 69's lane, design-system §5).
//
// Task 69's finding, restated because it is the whole reason this file exists: a model test can
// prove a FUNCTION returns `refused`, and cannot prove the SCREEN performs the composition it
// assumes. Break one prop — the `disabled` on the shutter, the state that selects the refusal
// dialog, the band→banner mapping — and every model assertion stays green while the app ships a
// live shutter over a full disk. So everything below mounts the real component and reads the real
// rendered props.
//
// Queries are by `testID`, by public prop, and by TOKEN VALUE (T-4 — never by rendered copy, except
// where the assertion IS "this equals what the catalog returns for this key"). Reading tokens is
// how a variant that carries no prop through the host boundary — `Button variant`, `Banner variant`
// — is still witnessed: `secondary` means a `surface` fill, `danger` means `dangerBg`, and those
// are design-system §1.1/§3.1 facts rather than incidental styling.
import { color } from '@bolusi/ui';
import { t } from '@bolusi/i18n';
import type { StorageBand } from '@bolusi/core';
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { render } from '../../../../packages/ui/test/render.js';

import { CaptureScreen, storageBanner, type CaptureScreenState } from './CaptureScreen.js';

/**
 * The already-localized title the FLOW supplies (see the prop's doc: 06 has no capture-screen title
 * key and the catalog is a contended package this task may not extend). Hoisted out of the JSX
 * because it is inert fixture data, not copy — the same reason the shared config exempts
 * `packages/ui`'s own component tests from `bolusi/no-hardcoded-strings`.
 */
const TITLE = 'Foto kerusakan';

function renderCapture(state: CaptureScreenState, handlers: Record<string, () => void> = {}) {
  return render(
    <CaptureScreen
      title={TITLE}
      state={state}
      preview={<></>}
      syncChip={<></>}
      avatar={<></>}
      onShutter={handlers['onShutter'] ?? vi.fn()}
      onRetake={handlers['onRetake'] ?? vi.fn()}
      onUsePhoto={handlers['onUsePhoto'] ?? vi.fn()}
      onRetry={handlers['onRetry'] ?? vi.fn()}
      onBack={handlers['onBack'] ?? vi.fn()}
    />,
  );
}

const READY: CaptureScreenState = { kind: 'ready', band: 'normal' };

afterEach(() => {
  vi.useRealTimers();
});

describe('design-system §5 — the mandatory states this screen has', () => {
  test.each(['permission_pending', 'warming_up'] as const)(
    'LOADING (%s): a spinner, and no viewfinder behind it',
    (kind) => {
      // `LoadingState` deliberately renders NOTHING for the first `LOADING_DELAY_MS` (§5: "Must NOT
      // … show for local queries resolved < 300 ms"), so the timer has to be advanced for the
      // spinner to exist. Asserting presence without that would have quietly asserted `null`.
      vi.useFakeTimers();
      const screen = renderCapture({ kind });
      expect(screen.query('capture-loading')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.query('capture-loading')).not.toBeNull();
      // The preview surface is NOT mounted behind it: a camera view attached before it is ready
      // shows a black or frozen frame, which reads as a broken app.
      expect(screen.query('capture-viewfinder')).toBeNull();
      expect(screen.query('capture-shutter')).toBeNull();
    },
  );

  test('UNAUTHORIZED: a denied camera permission is a LOCK, never an empty box', () => {
    // §5: Unauthorized "must not masquerade as Empty" and must not dead-end. The title is the same
    // sentence the OS permission dialog shows, so the two never contradict each other.
    const screen = renderCapture({ kind: 'permission_denied' });
    expect(screen.query('capture-unauthorized')).not.toBeNull();
    expect(screen.get('capture-unauthorized.title').props['children']).toBe(
      t('media.permission.camera'),
    );
    expect(screen.query('capture-unauthorized.back')).not.toBeNull();
    expect(screen.query('capture-shutter')).toBeNull();
  });

  test('ERROR (06 §7): a full disk gets an EXPLICIT dialog and NO shutter', () => {
    // PRD-012 §6: a silent camera death "will be discovered at the worst moment". The load-bearing
    // half is the second assertion — a refusal that still rendered a live shutter would be a button
    // that does nothing, which is the one thing a button must never do.
    const screen = renderCapture({ kind: 'refused_low_storage' });
    expect(screen.get('capture-refused.title').props['children']).toBe(
      t('media.capture.refusedTitle'),
    );
    expect(screen.get('capture-refused.hint').props['children']).toBe(
      t('media.capture.refusedBody'),
    );
    expect(screen.query('capture-shutter')).toBeNull();
    expect(screen.query('capture-viewfinder')).toBeNull();
  });

  test('ERROR: a failed capture shows the CODE for support, and a retry', () => {
    const onRetry = vi.fn();
    const screen = renderCapture({ kind: 'failed', code: 'CAMERA_UNAVAILABLE' }, { onRetry });
    expect(screen.get('capture-failed.code').props['children']).toBe('CAMERA_UNAVAILABLE');
    // §5: "dead-end without retry/back" is a review failure. The retry is wired to the handler.
    expect(screen.get('capture-failed.retry').props['onPress']).toBeTypeOf('function');
  });
});

describe('the ready state — one control, in the thumb zone', () => {
  test('the viewfinder mounts its preview slot and the shutter is live', () => {
    const onShutter = vi.fn();
    const screen = renderCapture(READY, { onShutter });
    expect(screen.query('capture-viewfinder')).not.toBeNull();

    const shutter = screen.get('capture-shutter');
    expect(shutter.props['accessibilityLabel']).toBe(t('media.action.takePhoto'));
    expect(shutter.props['disabled']).toBe(false);
    // `Button` gates `onPress` itself rather than leaning on RN (the double deliberately does not
    // swallow presses), so a live control is one that HAS a handler.
    expect(shutter.props['onPress']).toBeTypeOf('function');
  });

  test('CAPTURING disables the shutter and marks it busy — a second press cannot duplicate a row', () => {
    // §3.1's `busy` is for LOCAL work, and this is: downscale, re-encode, hash, move, insert. That
    // window is real CPU on a 2 GB device and it is the one moment a double-tap makes two rows.
    const screen = renderCapture({ kind: 'capturing' });
    const shutter = screen.get('capture-shutter');
    expect(shutter.props['disabled']).toBe(true);
    expect(shutter.props['accessibilityState']).toEqual({ disabled: true, busy: true });
    // The handler is UNWIRED, which is how "disabled means not pressable" is witnessed here.
    expect(shutter.props['onPress']).toBeUndefined();
    // And the spinner has taken the label's place, width-stable (§3.1).
    expect(screen.query('capture-shutter.spinner')).not.toBeNull();
  });

  test('REVIEW offers retake and use — exactly one primary fill', () => {
    const screen = renderCapture({ kind: 'review', previewUri: 'file:///documents/media/x.jpg' });

    expect(screen.get('capture-retake').props['accessibilityLabel']).toBe(t('media.action.retake'));
    expect(screen.get('capture-use').props['accessibilityLabel']).toBe(t('media.action.usePhoto'));
    // §3.1: `secondary` is a `surface` fill with an outline; `primary` is `color.primary`. Reading
    // the token is what makes "one primary" an assertion rather than a comment.
    expect(screen.styleOf('capture-retake')['backgroundColor']).toBe(color.surface);
    expect(screen.styleOf('capture-use')['backgroundColor']).toBe(color.primary);
    // The shutter is gone — a third control here is how a technician re-shoots by accident.
    expect(screen.query('capture-shutter')).toBeNull();
  });
});

describe('06 §7 — the storage banners are wired to the band', () => {
  test.each([
    ['warning' as StorageBand, color.warningBg, 'media.storage.lowWarning'] as const,
    ['loud' as StorageBand, color.dangerBg, 'media.storage.lowCritical'] as const,
  ])('band %s renders its banner from the catalog', (band, background, key) => {
    const screen = renderCapture({ kind: 'ready', band });
    expect(screen.styleOf('capture-storage-banner')['backgroundColor']).toBe(background);
    expect(screen.get('capture-storage-banner.message').props['children']).toBe(t(key));
    expect(storageBanner(band)?.message).toBe(t(key));
    // The viewfinder is still there — a warning does not stop the technician working.
    expect(screen.query('capture-viewfinder')).not.toBeNull();
  });

  test('POSITIVE CONTROL: a normal band renders NO banner', () => {
    // Without this, the two above would pass on a screen that always drew a banner — ambient noise
    // that trains people to ignore the one that matters (design-system §3.6's whole argument).
    expect(renderCapture(READY).query('capture-storage-banner')).toBeNull();
    expect(storageBanner('normal')).toBeNull();
  });

  test('`capture_refused` yields no banner — it is a whole screen state, not a strip', () => {
    // A banner would leave the viewfinder and shutter on screen behind it, implying a shutter that
    // works. §7 wants a refusal.
    expect(storageBanner('capture_refused')).toBeNull();
  });
});

describe('the screen contains no hardcoded copy', () => {
  test('every label it renders equals the catalog value for its key', () => {
    // A literal typed into the component fails this even when it looks identical, because the
    // comparison is against `t(key)` rather than against a string in this file.
    const screen = renderCapture(READY);
    expect(screen.get('capture-shutter.label').props['children']).toBe(t('media.action.takePhoto'));
    const review = renderCapture({ kind: 'review', previewUri: 'x' });
    expect(review.get('capture-retake.label').props['children']).toBe(t('media.action.retake'));
    expect(review.get('capture-use.label').props['children']).toBe(t('media.action.usePhoto'));
    // And the Indonesian catalog really is the one loaded (07-i18n §1.2's default locale) — so a
    // green run here is a statement about the language a technician actually sees.
    expect(t('media.action.takePhoto')).toBe('Ambil Foto');
  });
});
