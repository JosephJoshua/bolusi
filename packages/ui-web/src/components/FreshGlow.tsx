// A soft highlight behind a row or card a colleague just changed, fading out over a second. Put it
// inside a positioned parent that makes a stacking context (a transformed table row does): it sits
// under the content, never takes the mouse, and renders only while glowing.
import { FRESH_MS, useFresh } from '@bolusi/ui/fresh';
import { clsx } from 'clsx';

export function FreshGlow({
  id,
  className,
}: {
  /** The record shown: the id another device's change names. */
  readonly id: string;
  readonly className?: string | undefined;
}): React.JSX.Element | null {
  const at = useFresh(id);
  if (at === 0) return null;
  return (
    <span
      // A new mark remounts it, so a second change a moment later glows again.
      key={at}
      aria-hidden
      data-fresh=""
      className={clsx(
        'pointer-events-none absolute inset-0 -z-10 bg-info-bg animate-fresh',
        className,
      )}
      style={{ animationDuration: `${String(FRESH_MS)}ms` }}
    />
  );
}
