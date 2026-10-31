// Small layout pieces for detail panes and forms: a titled section, label/value facts, a card.
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

import { FreshGlow } from './FreshGlow.js';

export function Section({
  title,
  action,
  children,
  className,
  testId,
}: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <section data-testid={testId} className={clsx('flex flex-col gap-3', className)}>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h3 className="text-heading font-semibold text-text">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function FactGrid({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-6 gap-y-4">
      {children}
    </dl>
  );
}

/**
 * A label over its value, with the one action that changes it. A `wide` fact takes the whole row
 * (a list one per line), and its action sits at the end of the label's line, so it stays put
 * however many lines the value takes.
 */
export function Fact({
  label,
  value,
  action,
  wide = false,
  testId,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly action?: ReactNode;
  readonly wide?: boolean | undefined;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  if (wide) {
    return (
      <div data-testid={testId} className="col-span-full min-w-0">
        <dt className="flex items-center justify-between gap-2 text-small text-text-muted">
          {label}
          {action}
        </dt>
        <dd className="break-words text-body font-semibold text-text">{value}</dd>
      </div>
    );
  }
  return (
    <div data-testid={testId} className="min-w-0">
      <dt className="text-small text-text-muted">{label}</dt>
      <dd className="flex items-center gap-1 text-body font-semibold text-text">
        <span className="min-w-0 break-words">{value}</span>
        {action}
      </dd>
    </div>
  );
}

export function Card({
  children,
  className,
  freshId,
  testId,
}: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
  /** The record the card shows: it glows once when another device changes it (`FreshGlow`). */
  readonly freshId?: string | undefined;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className={clsx(
        'rounded-md border border-border bg-surface p-4',
        // Its own layer, so the glow sits over the card's fill and under its content.
        freshId !== undefined && 'relative isolate',
        className,
      )}
    >
      {freshId === undefined ? null : <FreshGlow id={freshId} className="rounded-md" />}
      {children}
    </div>
  );
}
