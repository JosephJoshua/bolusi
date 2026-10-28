// A QR code drawn as one SVG path: crisp at any size, black on white with the quiet zone scanners
// need, whatever the theme.
import { useMemo } from 'react';
import { qrModules } from '@bolusi/ui/qr';

export function QrCode({
  value,
  label,
  size = 224,
  testId,
}: {
  readonly value: string;
  /** What the code is for, read out instead of the picture. */
  readonly label: string;
  /** Pixels, or any CSS length (`min(264px, 30vh)`) to fit a short screen. */
  readonly size?: number | string;
  readonly testId?: string;
}): React.JSX.Element {
  const { modules, path } = useMemo(() => {
    const { size: count, runs } = qrModules(value);
    // One rectangle per run of dark modules in a row.
    const d = runs
      .map(({ x, y, length }) => `M${String(x)} ${String(y)}h${String(length)}v1H${String(x)}z`)
      .join('');
    return { modules: count, path: d };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      style={{ width: size, height: size }}
      viewBox={`0 0 ${String(modules)} ${String(modules)}`}
      shapeRendering="crispEdges"
      data-testid={testId}
      data-value={value}
      className="rounded-sm"
    >
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
