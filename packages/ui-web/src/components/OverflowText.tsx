// One line of data that may not fit, such as a long complaint in a table cell: cut with an ellipsis,
// and the whole text in a tooltip, offered only when something was actually cut off.
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { clsx } from 'clsx';
import { useRef, useState } from 'react';

export function OverflowText({
  text,
  className,
  testId,
}: {
  readonly text: string;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <RadixTooltip.Root
      open={open}
      onOpenChange={(next) => {
        const el = ref.current;
        setOpen(next && el !== null && el.scrollWidth > el.clientWidth);
      }}
    >
      <RadixTooltip.Trigger asChild>
        <span ref={ref} data-testid={testId} className={clsx('block truncate', className)}>
          {text}
        </span>
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-96 rounded-sm bg-text px-2 py-1 text-small break-words text-surface shadow-md data-[state=delayed-open]:animate-fade-in data-[state=instant-open]:animate-fade-in data-[state=closed]:animate-fade-out"
        >
          {text}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
