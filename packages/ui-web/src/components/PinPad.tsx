// A PIN pad for the counter PC: dots that fill as digits go in, typed on the keyboard (digits,
// Backspace) or clicked on the keys below for a touchscreen counter. It hands the PIN over once all
// digits are in and clears itself; the screen around it says what happened. The PIN lives only in
// this component's state while it is typed, and never in the DOM as text.
import { clsx } from 'clsx';
import { Delete } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export type PinPadState = 'entry' | 'error' | 'locked' | 'busy';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, '0', 'delete'] as const;

export function PinPad({
  length = 6,
  state,
  onComplete,
  label,
  deleteLabel,
  testId,
}: {
  readonly length?: number | undefined;
  /** `error` shakes the dots red once; `locked` and `busy` take no input. */
  readonly state: PinPadState;
  readonly onComplete: (pin: string) => void;
  /** What the dots are, for a screen reader ("PIN"). */
  readonly label: string;
  readonly deleteLabel: string;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const [digits, setDigits] = useState('');
  const live = state === 'entry' || state === 'error';
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;

  const typed = useRef('');
  const press = useCallback(
    (key: string) => {
      if (!live) return;
      const next = key === 'delete' ? typed.current.slice(0, -1) : `${typed.current}${key}`;
      if (next.length < length) {
        typed.current = next;
        setDigits(next);
        return;
      }
      typed.current = '';
      setDigits('');
      completeRef.current(next);
    },
    [live, length],
  );

  // The whole window types into the pad: there is nothing else on a PIN screen to type into.
  // Attached as the pad shows and detached as it goes, in the same commit: a passive effect lags a
  // frame, so keys typed straight after the next step appeared went to the pad it replaced.
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (/^[0-9]$/.test(event.key)) press(event.key);
      else if (event.key === 'Backspace') press('delete');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  return (
    <div className="flex flex-col items-center gap-6" data-testid={testId} data-state={state}>
      <div
        role="status"
        aria-label={`${label}: ${String(digits.length)}/${String(length)}`}
        className={clsx('flex gap-3', state === 'error' && 'animate-shake')}
        data-testid={testId === undefined ? undefined : `${testId}.dots`}
        data-filled={digits.length}
      >
        {Array.from({ length }, (_, index) => (
          <span
            key={index}
            aria-hidden
            className={clsx(
              'size-3.5 rounded-full border-2 transition-colors',
              index < digits.length
                ? state === 'error'
                  ? 'border-danger bg-danger'
                  : 'border-primary bg-primary'
                : state === 'error'
                  ? 'border-danger'
                  : 'border-text-muted',
            )}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {KEYS.map((key, index) =>
          key === null ? (
            <span key={`blank-${String(index)}`} aria-hidden />
          ) : (
            <button
              key={key}
              type="button"
              tabIndex={-1}
              disabled={!live || (key === 'delete' && digits === '')}
              aria-label={key === 'delete' ? deleteLabel : key}
              onClick={() => press(key)}
              data-testid={testId === undefined ? undefined : `${testId}.key.${key}`}
              className={clsx(
                'flex h-12 w-20 cursor-pointer items-center justify-center rounded-sm text-heading font-semibold tabular-nums text-text',
                'hover:bg-surface-alt active:bg-border disabled:cursor-default disabled:text-text-disabled disabled:hover:bg-transparent',
                key !== 'delete' && 'bg-surface-alt/60',
              )}
            >
              {key === 'delete' ? <Delete size={20} aria-hidden /> : key}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
