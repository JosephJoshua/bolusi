// A QR code drawn as one SVG path: crisp at any size, black on white with the quiet zone scanners
// need, whatever the theme.
import { useMemo } from 'react';
import { encode } from 'uqr';

export function QrCode({
  value,
  label,
  size = 224,
  testId,
}: {
  readonly value: string;
  /** What the code is for, read out instead of the picture. */
  readonly label: string;
  readonly size?: number;
  readonly testId?: string;
}): React.JSX.Element {
  const { modules, path } = useMemo(() => {
    const { data } = encode(value, { ecc: 'M', border: 4 });
    // One rectangle per run of dark modules in a row.
    const runs: string[] = [];
    data.forEach((row, y) => {
      let start = -1;
      row.forEach((dark, x) => {
        if (dark && start < 0) start = x;
        if (start >= 0 && (!dark || x === row.length - 1)) {
          const end = dark ? x + 1 : x;
          runs.push(`M${String(start)} ${String(y)}h${String(end - start)}v1H${String(start)}z`);
          start = -1;
        }
      });
    });
    const d = runs.join('');
    return { modules: data.length, path: d };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
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
