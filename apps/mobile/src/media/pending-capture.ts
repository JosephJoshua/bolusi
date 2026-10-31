// The deferred behind an evidence capture (06 §2): a screen awaits a promise while the shell shows
// the camera, the signature pad or the video recorder. Shared by the hosts so they settle, refuse a
// second request and guard against a user switch the same way.
import type { CapturedMedia } from '@bolusi/modules/screen-kit';
import { useCallback, useEffect, useRef } from 'react';

import type { CaptureIdentity } from '@bolusi/device/media/capture';

export interface PendingCapture<T = CapturedMedia> {
  /** Start a capture for the acting user. Rejects when one is already open. */
  readonly open: () => Promise<T | null>;
  /** Close the surface and hand the caller its answer. Idempotent: a double tap resolves once. */
  readonly settle: (value: T | null) => void;
  /** Whether a caller is still waiting (false once settled or backed out). */
  readonly isOpen: () => boolean;
  /**
   * True when the open capture belongs to a different user than the one acting now: an idle lock
   * ended the session and someone else unlocked. The host renders nothing and the capture is
   * cancelled, so nobody sees or completes another user's capture. A transient `null` identity is
   * a lock, not a switch, so the same user's lock and unlock returns to their capture.
   */
  readonly stranded: boolean;
  /** The acting identity, read at the moment of capture (06 §4 freezes it into the ref). */
  readonly identity: () => CaptureIdentity | null;
}

export function usePendingCapture<T = CapturedMedia>(
  identity: CaptureIdentity | null,
  onClose: () => void,
): PendingCapture<T> {
  const settleRef = useRef<((value: T | null) => void) | null>(null);
  const openedForUserRef = useRef<string | null>(null);
  const identityRef = useRef<CaptureIdentity | null>(identity);
  identityRef.current = identity;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const settle = useCallback((value: T | null): void => {
    const resolve = settleRef.current;
    settleRef.current = null;
    openedForUserRef.current = null;
    onCloseRef.current();
    resolve?.(value);
  }, []);

  const open = useCallback((): Promise<T | null> => {
    if (settleRef.current !== null) {
      // Replacing would strand the first caller's promise forever.
      return Promise.reject(new Error('a capture is already in progress'));
    }
    const pending = new Promise<T | null>((resolve) => {
      settleRef.current = resolve;
    });
    openedForUserRef.current = identityRef.current?.userId ?? null;
    return pending;
  }, []);

  const actingUser = identity?.userId ?? null;
  const stranded =
    settleRef.current !== null &&
    openedForUserRef.current !== null &&
    actingUser !== null &&
    actingUser !== openedForUserRef.current;

  useEffect(() => {
    if (stranded) settle(null);
  }, [stranded, settle]);

  return {
    open,
    settle,
    isOpen: useCallback(() => settleRef.current !== null, []),
    stranded,
    identity: useCallback(() => identityRef.current, []),
  };
}
