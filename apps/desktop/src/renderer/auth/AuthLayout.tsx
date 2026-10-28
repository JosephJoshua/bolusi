// The frame of every screen before someone is signed in (opening, registering the PC, choosing who
// is here, the PIN): the title bar, naming the store once known, over one card centred on a quiet
// background.
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

import { TitleBar } from '../TitleBar.js';

export function AuthLayout({
  storeName,
  width = 'narrow',
  children,
  testId,
}: {
  /** The store this PC belongs to, once it is registered. */
  readonly storeName?: string | null | undefined;
  /** `wide` for the people grid; `narrow` for a form or the PIN. */
  readonly width?: 'narrow' | 'wide';
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <TitleBar storeName={storeName} />
      <main
        className="flex min-h-0 flex-1 flex-col items-center overflow-auto bg-surface-alt px-6 py-12"
        data-testid={testId}
      >
        {/* `my-auto` centres the card while it fits and lets a tall one scroll from its top. */}
        <div
          className={clsx(
            'my-auto flex w-full flex-col gap-4',
            width === 'wide' ? 'max-w-3xl' : 'max-w-md',
          )}
        >
          <section className="animate-rise-in rounded-md bg-surface p-8 shadow-sm">
            {children}
          </section>
        </div>
      </main>
    </div>
  );
}

/** A screen's title and, when it says something the title does not, one short line under it. */
export function AuthHeading({
  title,
  lead,
  align = 'start',
}: {
  readonly title: string;
  readonly lead?: string | undefined;
  readonly align?: 'start' | 'center';
}): React.JSX.Element {
  return (
    <header
      className={clsx('mb-6 flex flex-col gap-1', align === 'center' && 'items-center text-center')}
    >
      <h1 className="text-title font-bold text-text">{title}</h1>
      {lead === undefined ? null : <p className="text-body text-text-muted">{lead}</p>}
    </header>
  );
}
