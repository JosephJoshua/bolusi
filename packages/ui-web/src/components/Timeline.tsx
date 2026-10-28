export interface TimelineEntry {
  readonly key: string;
  readonly title: string;
  readonly meta: string;
  readonly detail?: string | undefined;
}

/** What happened, newest first, as a line of dots. */
export function Timeline({
  entries,
  testId,
}: {
  readonly entries: readonly TimelineEntry[];
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <ol data-testid={testId} className="flex flex-col">
      {entries.map((entry, index) => (
        <li key={entry.key} className="relative flex gap-3 pb-4 last:pb-0">
          {index === entries.length - 1 ? null : (
            <span aria-hidden className="absolute left-[5px] top-4 h-full w-px bg-border" />
          )}
          <span
            aria-hidden
            className={
              index === 0
                ? 'relative mt-1.5 size-[11px] shrink-0 rounded-full bg-primary'
                : 'relative mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-border bg-surface'
            }
          />
          <div className="min-w-0">
            <p className="text-body font-semibold text-text">{entry.title}</p>
            <p className="text-small text-text-muted">{entry.meta}</p>
            {entry.detail === undefined ? null : (
              <p className="mt-1 whitespace-pre-line break-words text-body text-text">
                {entry.detail}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
