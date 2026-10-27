import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly icon?: LucideIcon | undefined;
  readonly tone?: 'plain' | 'danger';
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** Draws a separator above this item. */
  readonly separated?: boolean;
}

/** A dropdown of actions under a trigger, such as the user menu. */
export function Menu({
  trigger,
  items,
  header,
  align = 'end',
}: {
  readonly trigger: ReactNode;
  readonly items: readonly MenuItem[];
  readonly header?: ReactNode;
  readonly align?: 'start' | 'end';
}): React.JSX.Element {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          align={align}
          sideOffset={6}
          className="z-50 min-w-56 origin-(--radix-dropdown-menu-content-transform-origin) rounded-sm border border-border bg-surface p-1 shadow-lg data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out"
        >
          {header === undefined ? null : (
            <RadixMenu.Label className="px-3 py-2">{header}</RadixMenu.Label>
          )}
          {items.map((item) => (
            <div key={item.key}>
              {item.separated === true ? (
                <RadixMenu.Separator className="my-1 h-px bg-border" />
              ) : null}
              <RadixMenu.Item
                disabled={item.disabled === true}
                onSelect={item.onSelect}
                className={clsx(
                  'flex h-9 cursor-pointer select-none items-center gap-3 rounded-xs px-3 text-body outline-none data-[disabled]:cursor-not-allowed data-[disabled]:text-text-disabled',
                  item.tone === 'danger'
                    ? 'text-danger data-[highlighted]:bg-danger-bg'
                    : 'text-text data-[highlighted]:bg-surface-alt',
                )}
              >
                {item.icon === undefined ? null : <item.icon size={16} aria-hidden />}
                {item.label}
              </RadixMenu.Item>
            </div>
          ))}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}
