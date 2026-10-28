// One page of Settings: its title, one line on what it is for, and the content.
import type { ReactNode } from 'react';

export function SettingsPanel({
  title,
  lead,
  actions,
  children,
  testId,
}: {
  readonly title: string;
  readonly lead?: string | undefined;
  /** Beside the title: the page's main action when it is not a form ("Tambah karyawan"). */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <section className="flex min-h-full flex-col pb-6" data-testid={testId}>
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 pb-6">
        <div className="flex min-w-0 max-w-2xl flex-1 flex-col gap-1">
          <h2 className="break-words text-heading font-semibold text-text">{title}</h2>
          {lead === undefined ? null : <p className="text-body text-text-muted">{lead}</p>}
        </div>
        {actions === undefined ? null : (
          <div className="flex shrink-0 items-center gap-3">{actions}</div>
        )}
      </header>
      <div className="flex flex-1 flex-col gap-6">{children}</div>
    </section>
  );
}
