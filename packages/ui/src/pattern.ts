// The geometry of the Android 3 x 3 unlock pattern, shared by the phone's and the PC's pads.
// Dots are numbered 1-9 from the top left; a pattern is the dots in drawing order ("15963").
// As on Android, passing over the dot between two others takes it in, and each dot is used once.

export interface PatternPoint {
  readonly x: number;
  readonly y: number;
}

/** The centre of a dot on a grid of square cells. */
export function patternCentre(dot: number, cell: number): PatternPoint {
  const index = dot - 1;
  return { x: ((index % 3) + 0.5) * cell, y: (Math.floor(index / 3) + 0.5) * cell };
}

/** The dot under a point, when close enough to its centre. */
export function patternDotAt(point: PatternPoint, cell: number): number | null {
  const col = Math.floor(point.x / cell);
  const row = Math.floor(point.y / cell);
  if (col < 0 || col > 2 || row < 0 || row > 2) return null;
  const dot = row * 3 + col + 1;
  const c = patternCentre(dot, cell);
  return Math.hypot(point.x - c.x, point.y - c.y) <= cell * 0.38 ? dot : null;
}

/** The dot exactly between two others (1 and 3 → 2; 1 and 9 → 5), if there is one. */
function between(a: number, b: number): number | null {
  const [ar, ac] = [Math.floor((a - 1) / 3), (a - 1) % 3];
  const [br, bc] = [Math.floor((b - 1) / 3), (b - 1) % 3];
  if ((ar + br) % 2 !== 0 || (ac + bc) % 2 !== 0) return null;
  return ((ar + br) / 2) * 3 + (ac + bc) / 2 + 1;
}

/** The pattern after the finger (or pointer) passes `point`: a new dot, and any it jumped over. */
export function extendPattern(dots: string, point: PatternPoint, cell: number): string {
  const dot = patternDotAt(point, cell);
  if (dot === null || dots.includes(String(dot))) return dots;
  const last = dots.at(-1);
  const middle = last === undefined ? null : between(Number(last), dot);
  const jumped = middle !== null && !dots.includes(String(middle)) ? String(middle) : '';
  return dots + jumped + String(dot);
}
