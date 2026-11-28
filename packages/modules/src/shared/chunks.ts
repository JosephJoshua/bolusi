// SQLite caps bound parameters; a list of ids read with `in` goes in slices of this size.
export const CHUNK = 500;

export function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK));
  return out;
}
