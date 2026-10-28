import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

/** Mount once near the root; every tooltip shares its delay. */
export function TooltipProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

/**
 * A short label on hover or focus, for icon-only controls and shortened text, with the keyboard
 * shortcut beside it when the action has one, so counter staff learn it by seeing it.
 */
export function Tooltip({
  label,
  shortcut,
  children,
  side = 'top',
  disabled = false,
}: {
  readonly label: string;
  readonly shortcut?: string | undefined;
  readonly children: ReactNode;
  readonly side?: 'top' | 'bottom' | 'left' | 'right' | undefined;
  /** Shows nothing, for a label that is already fully on screen. */
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <RadixTooltip.Root {...(disabled ? { open: false } : {})}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-50 flex max-w-80 items-center gap-2 rounded-sm bg-text px-2 py-1 text-small text-surface shadow-md data-[state=delayed-open]:animate-fade-in data-[state=instant-open]:animate-fade-in data-[state=closed]:animate-fade-out"
        >
          <span className="break-words">{label}</span>
          {shortcut === undefined ? null : (
            <kbd className="shrink-0 rounded-xs bg-white/20 px-1 font-sans text-small font-semibold">
              {shortcut}
            </kbd>
          )}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
