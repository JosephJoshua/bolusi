// The in-app code scanner: reads a barcode or QR code with the camera for the items list and the
// item form (`InventoryRuntime.scanCode`). Like `SignatureHost` it holds the promise a screen awaits
// and hands the shell a surface to render while the camera looks. Nothing is stored: a scan is a
// string handed back, so it needs no media pipeline and no signing identity.
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** The native seams, bound where `expo-camera` is imported (`native-capture.tsx`). */
export interface ScanPlatform {
  /** Ask for the camera permission; whether it is granted. */
  ensurePermission(): Promise<boolean>;
  /** The live viewfinder, calling `onCode` with each code it reads. */
  renderScanner(onCode: (code: string) => void): ReactNode;
}

export type ScanScreenState =
  | { readonly kind: 'permission_pending' }
  | { readonly kind: 'permission_denied' }
  | { readonly kind: 'scanning' };

/** What the shell renders while a scan runs. `null` ⇒ none is. */
export interface ScanSurface {
  readonly state: ScanScreenState;
  readonly preview: ReactNode;
  readonly onBack: () => void;
}

export interface ScanHost {
  /** Resolves the code read, or `null` when the person backed out. Absent without a camera. */
  readonly scanCode: (() => Promise<string | null>) | undefined;
  readonly surface: ScanSurface | null;
}

export function useScanHost(platform: ScanPlatform | null): ScanHost {
  const [state, setState] = useState<ScanScreenState | null>(null);
  const pending = useRef<((code: string | null) => void) | null>(null);

  const settle = useCallback((code: string | null): void => {
    const resolve = pending.current;
    if (resolve === null) return;
    pending.current = null;
    setState(null);
    resolve(code);
  }, []);

  const scanCode = useCallback((): Promise<string | null> => {
    if (platform === null) return Promise.reject(new Error('no camera to scan with'));
    if (pending.current !== null) return Promise.reject(new Error('a scan is already open'));
    const opened = new Promise<string | null>((resolve) => {
      pending.current = resolve;
    });
    setState({ kind: 'permission_pending' });
    void platform.ensurePermission().then(
      (granted) => {
        if (pending.current === null) return; // Backed out while the OS asked.
        setState({ kind: granted ? 'scanning' : 'permission_denied' });
      },
      () => {
        if (pending.current !== null) setState({ kind: 'permission_denied' });
      },
    );
    return opened;
  }, [platform]);

  // The camera reports a code on every frame it sees one: the first ends the scan, the rest find
  // nothing pending.
  const onCode = useCallback(
    (code: string): void => {
      const read = code.trim();
      if (read !== '') settle(read);
    },
    [settle],
  );

  const scanning = state?.kind === 'scanning';
  const preview = useMemo(
    () => (scanning && platform !== null ? platform.renderScanner(onCode) : null),
    [scanning, platform, onCode],
  );

  const surface = useMemo<ScanSurface | null>(
    () => (state === null ? null : { state, preview, onBack: () => settle(null) }),
    [state, preview, settle],
  );

  return { scanCode: platform === null ? undefined : scanCode, surface };
}
