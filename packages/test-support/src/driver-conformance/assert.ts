// Framework-free assertions. The conformance suite runs BOTH under vitest in CI and
// inside the in-app L6 Harness screen on device (testing-guide §2.6), and the harness has
// no test runner — so the suite cannot lean on `expect`.

export class ConformanceFailure extends Error {
  override readonly name = 'ConformanceFailure';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (!deepEqual(aKeys, bKeys)) return false;
    return aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  // Object.is separates +0/-0 and treats NaN as equal to itself — both matter for the
  // REAL column in the types round-trip case.
  return Object.is(a, b);
}

export function format(value: unknown): string {
  if (value instanceof Uint8Array) return `Uint8Array[${[...value].join(',')}]`;
  if (value === undefined) return 'undefined';
  return JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Uint8Array ? `Uint8Array[${[...item].join(',')}]` : item,
  );
}

export function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (deepEqual(actual, expected)) return;
  throw new ConformanceFailure(`${what}: expected ${format(expected)}, got ${format(actual)}`);
}

/** Asserts `fn` rejects with a `DbError` carrying `expectedCode`.
 *
 * The code is read structurally rather than via `instanceof DbError`: test-support's edge
 * to `@bolusi/db-client` is type-only (08 §3.3 keeps DB concerns out of this package), and
 * the portable error CODE is exactly what conformance is asserting is identical across
 * adapters. db-client's own tests cover the `DbError` class itself. */
export async function assertRejectsWithCode(
  fn: () => Promise<unknown>,
  expectedCode: string,
  what: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new ConformanceFailure(
      `${what}: expected a rejection with code ${expectedCode}, got none`,
    );
  }
  const actualCode = (thrown as { code?: unknown }).code;
  if (actualCode !== expectedCode) {
    const detail = thrown instanceof Error ? thrown.message : String(thrown);
    throw new ConformanceFailure(
      `${what}: expected code ${expectedCode}, got ${String(actualCode)} (${detail})`,
    );
  }
}
