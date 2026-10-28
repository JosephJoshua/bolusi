// The frame of every screen before someone is signed in (opening, registering the PC, choosing who
// is here, the PIN): one card centred on a quiet background, the store's name above it once known.
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

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
    <main
      className="flex h-full min-h-0 flex-col items-center overflow-auto bg-surface-alt px-6 py-12"
      data-testid={testId}
    >
      {/* `my-auto` centres the card while it fits and lets a tall one scroll from its top. */}
      <div
        className={clsx(
          'my-auto flex w-full flex-col gap-4',
          width === 'wide' ? 'max-w-3xl' : 'max-w-md',
        )}
      >
        {storeName === null || storeName === undefined || storeName === '' ? null : (
          <p
            className="break-words text-center text-body font-semibold text-text-muted"
            data-testid="auth.store"
          >
            {storeName}
          </p>
        )}
        <section className="animate-rise-in rounded-md bg-surface p-8 shadow-sm">
          {children}
        </section>
      </div>
    </main>
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
