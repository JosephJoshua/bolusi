// The customer's status page: opened from the QR or link on their slip (or WhatsApp), on their own
// phone, usually over mobile data. One column; the status leads, then what they owe, the warranty
// and the history; contacting the store is the one action, in a bar at the bottom.
import {
  customerPageView,
  tn,
  type CustomerPageView,
  type CustomerStatusTone,
} from '@bolusi/modules/repair/customer-page';
import { BrandMark, Button, ButtonLink, Skeleton, StatePanel, Timeline } from '@bolusi/ui-web';
import { clsx } from 'clsx';
import {
  CircleX,
  Clock,
  Link2Off,
  MessageCircle,
  PackageCheck,
  Phone,
  SearchX,
  WifiOff,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { fetchStatus, type StatusResult } from './api.js';

const TONE: Readonly<
  Record<CustomerStatusTone, { readonly icon: LucideIcon; readonly ring: string }>
> = {
  neutral: { icon: Wrench, ring: 'bg-info-bg text-info' },
  warning: { icon: Clock, ring: 'bg-warning-bg text-warning' },
  success: { icon: PackageCheck, ring: 'bg-success-bg text-on-success-bg' },
  danger: { icon: CircleX, ring: 'bg-danger-bg text-on-danger-bg' },
};

export function StatusPage({
  code,
  fetcher,
}: {
  readonly code: string;
  /** Tests pass their own; the page uses the browser's. */
  readonly fetcher?: typeof fetch | undefined;
}): React.JSX.Element {
  const [result, setResult] = useState<StatusResult | null>(null);
  const [reloading, setReloading] = useState(false);

  const load = useCallback(async () => {
    setReloading(true);
    setResult(await fetchStatus(code, fetcher));
    setReloading(false);
  }, [code, fetcher]);

  useEffect(() => {
    document.title = tn('repair.customerPage.title');
    void load();
  }, [load]);

  if (result === null) return <Loading />;
  switch (result.kind) {
    case 'found':
      return (
        <Found
          view={customerPageView(result.status)}
          onReload={() => void load()}
          reloading={reloading}
        />
      );
    case 'notFound':
      return (
        <Missing
          icon={SearchX}
          title={tn('repair.customerPage.notFound.title')}
          hint={tn('repair.customerPage.notFound.hint')}
          action={
            <ButtonLink href="/" size="lg" label={tn('repair.customerPage.notFound.retype')} />
          }
        />
      );
    case 'ended':
      return (
        <Missing
          icon={Link2Off}
          title={tn('repair.customerPage.ended.title')}
          hint={tn('repair.customerPage.ended.hint')}
        />
      );
    case 'failed':
      return (
        <Missing
          icon={WifiOff}
          title={tn('repair.customerPage.error.title')}
          hint={tn('repair.customerPage.error.hint')}
          action={
            <Button
              variant="primary"
              size="lg"
              label={tn('repair.customerPage.error.retry')}
              busy={reloading}
              onClick={() => void load()}
            />
          }
        />
      );
  }
}

function Column({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-[480px] flex-col gap-6 px-4 pb-6 pt-6">
      {children}
    </main>
  );
}

function Footer({ children }: { readonly children?: ReactNode }): React.JSX.Element {
  return (
    <footer className="mt-auto flex flex-col items-center gap-3 pt-6">
      {children}
      <BrandMark variant="wordmark" size={16} />
    </footer>
  );
}

function Loading(): React.JSX.Element {
  return (
    <Column>
      <div aria-busy className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-28 w-full" />
    </Column>
  );
}

function Missing({
  icon,
  title,
  hint,
  action,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly hint: string;
  readonly action?: ReactNode;
}): React.JSX.Element {
  return (
    <Column>
      <StatePanel icon={icon} title={title} hint={hint} action={action} />
      <Footer />
    </Column>
  );
}

function Rows({
  rows,
}: {
  readonly rows: readonly { readonly label: string; readonly amount: string }[];
}): React.JSX.Element {
  return (
    <dl className="flex flex-col gap-2">
      {rows.map((row) => (
        // A long label keeps a readable width and pushes its amount onto the next line, right-aligned.
        <div key={row.label} className="flex flex-wrap items-start gap-x-4">
          <dt className="min-w-0 flex-[1_1_10rem] break-words text-body text-text-muted">
            {row.label}
          </dt>
          <dd className="ml-auto shrink-0 whitespace-nowrap text-body font-semibold tabular-nums text-text">
            {row.amount}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Block({
  title,
  children,
  testId,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly testId?: string;
}): React.JSX.Element {
  return (
    <section data-testid={testId} className="flex flex-col gap-3">
      <h2 className="text-heading font-semibold text-text">{title}</h2>
      {children}
    </section>
  );
}

function Found({
  view,
  onReload,
  reloading,
}: {
  readonly view: CustomerPageView;
  readonly onReload: () => void;
  readonly reloading: boolean;
}): React.JSX.Element {
  const tone = TONE[view.tone];
  const StatusIcon = tone.icon;
  const contact = view.whatsAppUrl !== null || view.phoneUrl !== null;
  return (
    <>
      <Column>
        <header className="flex flex-col gap-1">
          <p className="text-heading font-semibold text-text">{view.storeName}</p>
          {view.storeLines.map((line) => (
            <p key={line} className="text-small text-text-muted">
              {line}
            </p>
          ))}
        </header>

        <section
          data-testid="status-card"
          className="flex flex-col gap-4 rounded-md border border-border bg-surface p-4"
        >
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className={clsx(
                'flex size-10 shrink-0 items-center justify-center rounded-full',
                tone.ring,
              )}
            >
              <StatusIcon size={22} />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="text-title font-semibold text-text">{view.status}</h1>
              {view.statusHint === null ? null : (
                <p className="text-body text-text-muted">{view.statusHint}</p>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-1 border-t border-border pt-4">
            <p className="break-words text-body font-semibold text-text">{view.device}</p>
            <p className="text-small text-text-muted">{view.reference}</p>
          </div>
        </section>

        {view.pendingPrices.length === 0 ? null : (
          <section
            data-testid="pending-prices"
            className="flex flex-col gap-3 rounded-md bg-warning-bg p-4"
          >
            <h2 className="text-heading font-semibold text-text">
              {tn('repair.customerPage.pending.title')}
            </h2>
            <Rows rows={view.pendingPrices} />
            <p className="text-body text-text">{tn('repair.customerPage.pending.hint')}</p>
          </section>
        )}

        <Block title={tn('repair.customerPage.money.title')} testId="money">
          <Rows rows={view.money.rows} />
          <div className="flex items-start justify-between gap-4 border-t border-border pt-3">
            <span className="text-body font-semibold text-text">{view.money.due.label}</span>
            <span className="whitespace-nowrap text-heading font-semibold tabular-nums text-text">
              {view.money.due.amount}
            </span>
          </div>
        </Block>

        {view.warranty.length === 0 ? null : (
          <Block title={tn('repair.warranty.title')} testId="warranty">
            <ul className="flex flex-col gap-2">
              {view.warranty.map((line) => (
                <li key={line} className="break-words text-body text-text">
                  {line}
                </li>
              ))}
            </ul>
            {view.warrantyNote === null ? null : (
              <p className="text-small text-text-muted">{view.warrantyNote}</p>
            )}
          </Block>
        )}

        <Block title={tn('repair.customerPage.history')} testId="history">
          <Timeline
            entries={view.steps.map((step) => ({
              key: step.key,
              title: step.title,
              meta: step.meta,
            }))}
          />
        </Block>

        <Footer>
          <div className="flex flex-wrap items-center justify-center gap-x-2 text-small text-text-muted">
            <span>{view.updated}</span>
            <Button
              variant="text"
              size="sm"
              label={tn('repair.customerPage.refresh')}
              busy={reloading}
              onClick={onReload}
            />
          </div>
        </Footer>
      </Column>

      {contact ? (
        <div className="sticky bottom-0 border-t border-border bg-surface">
          <div className="mx-auto flex w-full max-w-[480px] gap-3 px-4 py-3">
            {view.phoneUrl === null ? null : (
              <ButtonLink
                href={view.phoneUrl}
                size="lg"
                icon={Phone}
                label={tn('repair.customerPage.contact.call')}
              />
            )}
            {view.whatsAppUrl === null ? null : (
              <ButtonLink
                href={view.whatsAppUrl}
                target="_blank"
                rel="noopener noreferrer"
                variant="primary"
                size="lg"
                icon={MessageCircle}
                label={tn('repair.customerPage.contact.whatsApp')}
                className="flex-1"
              />
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
