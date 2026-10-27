// The Android 3 x 3 unlock pattern on a PC: drawn with the mouse the way the customer draws it on
// their phone, or typed as dot numbers (1-9 from the top left) with Enter, or shown read-only.
// Drawn dots show their order, so a pattern read off a ticket says where it starts. The geometry
// is the phone pad's (`@bolusi/ui/pattern`), so both record the same pattern for the same drawing.
import { extendPattern, patternCentre, type PatternPoint } from '@bolusi/ui/pattern';
import { clsx } from 'clsx';
import { useRef, useState } from 'react';

export function PatternPad({
  value,
  onChange,
  size = 216,
  label,
  testId,
}: {
  /** Dots 1-9 in drawing order; '' for none. */
  readonly value: string;
  /** Called when a drawing or typed pattern is finished. Absent: read-only. */
  readonly onChange?: ((value: string) => void) | undefined;
  readonly size?: number | undefined;
  /** The pad's accessible name; the steps are read after it. */
  readonly label: string;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const cell = size / 3;
  const [drawing, setDrawing] = useState<{ dots: string; pointer: PatternPoint | null } | null>(
    null,
  );
  const dots = useRef('');
  const svg = useRef<SVGSVGElement>(null);
  const editable = onChange !== undefined;

  const pointOf = (event: React.PointerEvent): PatternPoint => {
    const box = svg.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const finish = (): void => {
    setDrawing(null);
    if (dots.current !== '') onChange?.(dots.current);
  };

  const shown = drawing?.dots ?? value;
  const order = [...shown].map(Number);
  const last = order.at(-1);
  const radius = cell * 0.15;
  return (
    <svg
      ref={svg}
      role={editable ? 'application' : 'img'}
      aria-label={value === '' ? label : `${label}: ${[...value].join('-')}`}
      tabIndex={editable ? 0 : undefined}
      width={size}
      height={size}
      data-testid={testId}
      data-value={value}
      className={clsx(
        'shrink-0 touch-none select-none rounded-md bg-surface-alt',
        editable &&
          'cursor-pointer focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--b-primary)]',
      )}
      onPointerDown={
        editable
          ? (event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const point = pointOf(event);
              dots.current = extendPattern('', point, cell);
              setDrawing({ dots: dots.current, pointer: point });
            }
          : undefined
      }
      onPointerMove={
        editable
          ? (event) => {
              if (drawing === null) return;
              const point = pointOf(event);
              dots.current = extendPattern(dots.current, point, cell);
              setDrawing({ dots: dots.current, pointer: point });
            }
          : undefined
      }
      onPointerUp={editable ? finish : undefined}
      onPointerCancel={editable ? () => setDrawing(null) : undefined}
      onKeyDown={
        editable
          ? (event) => {
              // Typing the dots in order draws the same pattern, for a keyboard at the counter.
              if (/^[1-9]$/.test(event.key)) {
                event.preventDefault();
                const base = drawing?.dots ?? '';
                if (!base.includes(event.key)) {
                  dots.current = base + event.key;
                  setDrawing({ dots: dots.current, pointer: null });
                }
              } else if (event.key === 'Enter' && drawing !== null) {
                event.preventDefault();
                finish();
              } else if (event.key === 'Backspace' || event.key === 'Escape') {
                if (drawing === null) return;
                event.preventDefault();
                event.stopPropagation();
                setDrawing(null);
              }
            }
          : undefined
      }
      onBlur={editable && drawing !== null && drawing.pointer === null ? finish : undefined}
    >
      <g className="stroke-primary opacity-45" strokeWidth={6} strokeLinecap="round">
        {order.slice(1).map((dot, i) => {
          const from = patternCentre(order[i]!, cell);
          const to = patternCentre(dot, cell);
          return (
            <line
              key={`${String(order[i])}-${String(dot)}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
            />
          );
        })}
        {drawing?.pointer != null && last !== undefined ? (
          <line
            x1={patternCentre(last, cell).x}
            y1={patternCentre(last, cell).y}
            x2={drawing.pointer.x}
            y2={drawing.pointer.y}
          />
        ) : null}
      </g>
      {Array.from({ length: 9 }, (_, i) => {
        const dot = i + 1;
        const at = patternCentre(dot, cell);
        const step = order.indexOf(dot);
        return (
          <g
            key={dot}
            data-testid={testId === undefined ? undefined : `${testId}.dot.${String(dot)}`}
          >
            <circle
              cx={at.x}
              cy={at.y}
              r={radius}
              className={step >= 0 ? 'fill-primary' : 'fill-border'}
            />
            {step >= 0 ? (
              <text
                x={at.x}
                y={at.y}
                textAnchor="middle"
                dominantBaseline="central"
                className="fill-white text-small font-bold"
              >
                {step + 1}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
