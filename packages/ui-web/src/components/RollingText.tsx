// A figure that rolls to its new value when it changes while on screen: a rise rolls in from below,
// a drop from above. The first value is just there. Never for a figure being typed.
import { useChangeDirection } from '@bolusi/ui/direction';
import { clsx } from 'clsx';

export function RollingText({
  value,
  children,
  className,
  testId,
}: {
  /** What the text shows as a number; its change decides the direction. */
  readonly value: number;
  /** Already-formatted, e.g. `formatMoney(value)`. */
  readonly children: string;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const direction = useChangeDirection(value);
  return (
    <span
      // A new key per value plays the roll again.
      key={value}
      data-testid={testId}
      className={clsx(
        'inline-block',
        direction === 'up' && 'animate-roll-up',
        direction === 'down' && 'animate-roll-down',
        className,
      )}
    >
      {children}
    </span>
  );
}
