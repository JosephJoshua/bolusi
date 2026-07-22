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
import { hasKey, t } from '@bolusi/i18n';
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
    // §5: Unauthorized "must not masquerade as Empty" and must not dead-end.
    const screen = renderCapture({ kind: 'permission_denied' });
    expect(screen.query('capture-unauthorized')).not.toBeNull();
    expect(screen.query('capture-unauthorized.back')).not.toBeNull();
    expect(screen.query('capture-shutter')).toBeNull();
  });

  test('UNAUTHORIZED: the denial resolves the CAMERA-PERMISSION keys, never the device-revoked ones', () => {
    // Task 125. The hint used to be `auth.revoked.body`, so tapping "Deny" on the OS camera prompt
    // told a technician the shop had BLOCKED their handset and to get it re-enrolled — a false
    // revocation signal on a product where revocation is a real security control (api/02-auth §7.3).
    //
    // What is asserted is the BINDING, never the sentence (T-4): each rendered string is compared to
    // what the catalog returns for a key, and to what it returns for the WRONG key. Point the branch
    // back at `auth.revoked.body` and the second block reds.
    const screen = renderCapture({ kind: 'permission_denied' });
    const title = screen.get('capture-unauthorized.title').props['children'];
    const hint = screen.get('capture-unauthorized.hint').props['children'];

    // INTERROGATE THE ORACLE first (T-13): `not.toBe` against a key that resolved to `undefined`,
    // or to the same string as the right key, would pass while checking nothing. So prove the
    // revoked copy is present, non-empty and genuinely different before relying on its absence.
    for (const revoked of ['auth.revoked.title', 'auth.revoked.body'] as const) {
      expect(t(revoked)).not.toBe('');
      expect(t(revoked)).not.toBe(t('media.permission.cameraDeniedTitle'));
      expect(t(revoked)).not.toBe(t('media.permission.cameraDeniedBody'));
    }

    // THE DIFFERENT-KEY LEG, asserted before the positive one so that reintroducing the defect
    // trips *this* — "the denial resolved the revoked key" — and not merely "some string moved".
    for (const revoked of ['auth.revoked.title', 'auth.revoked.body'] as const) {
      expect(title).not.toBe(t(revoked));
      expect(hint).not.toBe(t(revoked));
    }

    expect(title).toBe(t('media.permission.cameraDeniedTitle'));
    expect(hint).toBe(t('media.permission.cameraDeniedBody'));
  });

  test('UNAUTHORIZED: the keys it resolves ship in BOTH catalogs, id and en', () => {
    // 07-i18n §7.1: `id` is the source language and `en` follows in the same PR. A key present only
    // in `id` renders the Indonesian sentence to an owner who toggled to English (§6's fallback) —
    // silently, which is the failure this asserts away. `zh` is scaffold-only (§1: no catalog files)
    // and is deliberately not in the list.
    for (const key of [
      'media.permission.cameraDeniedTitle',
      'media.permission.cameraDeniedBody',
    ] as const) {
      for (const locale of ['id', 'en'] as const) {
        expect(hasKey(key, locale)).toBe(true);
      }
    }
    // NEGATIVE CONTROL: `hasKey` is not a function that says `true` to everything, so the loop above
    // is an assertion rather than a formality (CLAUDE.md §2.11 — a guard must be able to go red).
    expect(hasKey('media.permission.cameraDeniedNothing', 'id')).toBe(false);
    expect(hasKey('media.permission.cameraDeniedNothing', 'en')).toBe(false);
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

  test('ERROR: the message is DERIVED from the code, not one fixed sentence for every failure', () => {
    // Same class as task 125's headline defect, found in the branch next door: the title was a
    // hardcoded `t('core.errors.UNEXPECTED')`, so a failure whose code the catalog DOES cover still
    // said "something went wrong" and the screen never named what broke. §5's Error row wants "what
    // failed … keyed by DomainError.code"; 07-i18n §4.2 makes that lookup derived, and
    // `translateErrorCode` is its one implementation.
    const covered = renderCapture({ kind: 'failed', code: 'STORAGE_ERROR' });
    const title = covered.get('capture-failed.title').props['children'];
    expect(title).toBe(t('core.errors.STORAGE_ERROR'));
    // The oracle again: the two rows differ, so `not.toBe` below is load-bearing.
    expect(t('core.errors.STORAGE_ERROR')).not.toBe(t('core.errors.UNEXPECTED'));
    expect(title).not.toBe(t('core.errors.UNEXPECTED'));

    // …and an UNCOVERED code still degrades to UNEXPECTED (§4.2, §6) rather than leaking a raw
    // dotted key onto the screen — the behaviour the hardcode got right, kept.
    const unknown = renderCapture({ kind: 'failed', code: 'NOT_A_REAL_CAPTURE_CODE' });
    expect(unknown.get('capture-failed.title').props['children']).toBe(t('core.errors.UNEXPECTED'));
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
