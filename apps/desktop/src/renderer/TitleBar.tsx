// The window's title bar, drawn by the page (see main's `window-chrome.ts`): Bolusi and the store on
// the left, the app's own controls on the right, and Windows' minimise, maximise and close beyond
// them. The empty part drags the window and a double click maximises it, as on any title bar; the
// controls opt out of dragging so a click on them is a click.
import { BrandMark, OverflowText } from '@bolusi/ui-web';
import { clsx } from 'clsx';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import type { WindowBridge } from '../main/bridge.js';

/** A control in the bar: quiet until pointed at, and a focus ring that shows on the dark bar. */
export const BAR_CONTROL =
  'flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-small text-chrome-muted transition-colors hover:bg-white/10 hover:text-chrome-text focus-visible:outline-chrome-text data-[state=open]:bg-white/10 data-[state=open]:text-chrome-text';

/** The product's name, the same in every language. */
const APP_NAME = 'Bolusi';

// Windows tells the page where its caption buttons are (the Window Controls Overlay values); outside
// the app, in a browser, the bar simply spans the page.
const FRAMED: CSSProperties = {
  height: 'env(titlebar-area-height, 40px)',
  paddingLeft: 'env(titlebar-area-x, 0px)',
  paddingRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))',
};
// Fullscreen has no caption buttons to leave room for.
const FULLSCREEN: CSSProperties = { height: 40 };

function windowBridge(): WindowBridge | undefined {
  return (globalThis as { bolusi?: { window?: WindowBridge } }).bolusi?.window;
}

function useFullscreen(bridge: WindowBridge | undefined = windowBridge()): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (bridge === undefined) return;
    let live = true;
    const off = bridge.onFullscreenChange((next) => {
      if (live) setFullscreen(next);
    });
    void bridge.fullscreen().then((next) => {
      if (live) setFullscreen(next);
    });
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  return fullscreen;
}

/** Whether this window has the keyboard; a background window's title dims, as Windows' own do. */
function useWindowActive(): boolean {
  const [active, setActive] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = (): void => setActive(true);
    const off = (): void => setActive(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('focus', on);
      window.removeEventListener('blur', off);
    };
  }, []);
  return active;
}

export function TitleBar({
  storeName,
  leading,
  children,
}: {
  /** The store this PC belongs to, once it is registered. */
  readonly storeName?: string | null | undefined;
  /** Sits over the sidebar's icon rail: the sidebar toggle. */
  readonly leading?: ReactNode;
  /** The app's controls at the right: update, sync, the person signed in. */
  readonly children?: ReactNode;
}): React.JSX.Element {
  const fullscreen = useFullscreen();
  const active = useWindowActive();
  const store =
    storeName === null || storeName === undefined || storeName.trim() === '' ? null : storeName;

  // The taskbar and Alt+Tab name the store too, which tells two counter windows apart.
  useEffect(() => {
    document.title = store === null ? APP_NAME : `${store} · ${APP_NAME}`;
  }, [store]);

  return (
    <header
      data-testid="desktop.titlebar"
      data-fullscreen={fullscreen ? 'true' : undefined}
      style={fullscreen ? FULLSCREEN : FRAMED}
      className={clsx(
        '@container flex shrink-0 select-none items-center bg-chrome text-chrome-text',
        !fullscreen && '[-webkit-app-region:drag]',
      )}
    >
      {leading === undefined ? null : (
        <div className="flex w-16 shrink-0 justify-center [-webkit-app-region:no-drag]">
          {leading}
        </div>
      )}
      <div
        className={clsx(
          'flex min-w-0 items-center gap-3 transition-opacity',
          leading === undefined && 'pl-4',
          !active && 'opacity-60',
        )}
      >
        <BrandMark size={20} tone="dark" label={null} />
        <span className="shrink-0 text-body font-semibold tracking-tight">{APP_NAME}</span>
        {store === null ? null : (
          <>
            <span aria-hidden className="h-4 w-px shrink-0 bg-white/20" />
            <OverflowText
              text={store}
              // Pointable, so a store name cut short shows whole in its tooltip.
              className="text-body text-chrome-muted [-webkit-app-region:no-drag]"
              testId="desktop.store"
            />
          </>
        )}
      </div>
      <div className="min-w-6 flex-1 self-stretch" />
      {children === undefined ? null : (
        <div className="flex shrink-0 items-center gap-1 pr-2 [-webkit-app-region:no-drag]">
          {children}
        </div>
      )}
    </header>
  );
}
