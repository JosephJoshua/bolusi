// The pages of a part of the app (Settings), listed down the left of it in titled groups. The
// current page is marked; a count beside an item says something there needs a look.
import { clsx } from 'clsx';

export interface SectionNavItem<T extends string> {
  readonly value: T;
  readonly label: string;
  /** A short status beside the label, such as "2 terkunci". */
  readonly badge?: string | undefined;
}

export interface SectionNavGroup<T extends string> {
  readonly key: string;
  /** Null for items that need no heading. */
  readonly title: string | null;
  readonly items: readonly SectionNavItem<T>[];
}

export function SectionNav<T extends string>({
  groups,
  value,
  onChange,
  label,
  testId,
}: {
  readonly groups: readonly SectionNavGroup<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** The navigation's accessible name. */
  readonly label: string;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <nav aria-label={label} data-testid={testId} className="flex flex-col gap-5">
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <div key={group.key} className="flex flex-col gap-1">
            {group.title === null ? null : (
              <p className="px-3 pb-1 text-small font-semibold text-text-muted">{group.title}</p>
            )}
            {group.items.map((item) => {
              const active = item.value === value;
              return (
                <button
                  key={item.value}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onChange(item.value)}
                  data-testid={testId === undefined ? undefined : `${testId}.${item.value}`}
                  className={clsx(
                    'flex min-h-9 cursor-pointer items-center gap-2 rounded-sm px-3 py-1.5 text-left text-body transition-colors',
                    active
                      ? 'bg-info-bg font-semibold text-info'
                      : 'text-text hover:bg-surface-alt',
                  )}
                >
                  <span className="min-w-0 flex-1 break-words leading-snug">{item.label}</span>
                  {item.badge === undefined ? null : (
                    <span className="shrink-0 whitespace-nowrap rounded-full bg-warning-bg px-2 text-small font-semibold text-warning">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
    </nav>
  );
}
