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

/** A short label on hover or focus, for icon-only controls and shortened text. */
export function Tooltip({
  label,
  children,
  side = 'top',
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
}): React.JSX.Element {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-72 rounded-sm bg-text px-2 py-1 text-small text-surface shadow-md"
        >
          {label}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
