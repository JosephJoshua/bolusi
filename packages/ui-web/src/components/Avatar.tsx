import { identityColor } from '@bolusi/ui/tokens';
import { clsx } from 'clsx';

function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words;
  return letters.map((word) => word[0]!.toUpperCase()).join('');
}

/** A person as their initials on their own colour, the same colour on every device. */
export function Avatar({
  userId,
  name,
  size = 32,
  className,
}: {
  readonly userId: string;
  readonly name: string;
  readonly size?: 28 | 32 | 40;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{ backgroundColor: identityColor(userId), width: size, height: size }}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
        size === 40 ? 'text-body' : 'text-small',
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
