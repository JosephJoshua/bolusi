// SEC-DEV-06 "DB at rest is ciphertext" — the L6 (on-device) leg (security-guide §6.5).
//
// SQLCipher is OFF in CI by design: better-sqlite3 has no SQLCipher build, so CI CANNOT
// witness encryption at rest, and pretending otherwise would be a fake green. What ships
// here is the probe itself — platform-free and injected — so that:
//   * the on-device runner (task 27) executes it against real SQLCipher on real hardware;
//   * CI compiles it AND unit-tests its detection logic against fakes, proving the probe
//     actually catches a plaintext database rather than rubber-stamping whatever it sees.
//
// Everything the probe touches (file copy, byte read, keyed open) is injected, because
// this package may not import a DB driver or a filesystem (08 §3.3).
import type { DbDriver } from '@bolusi/db-client';

export interface AtRestProbeContext {
  /**
   * Opens a driver against a COPY of the device's DB file — never the live one, which is
   * held by the app's single connection (08 §2.2).
   * `encryptionKey` is `null` to attempt an unkeyed open.
   */
  openCopy(encryptionKey: string | null): Promise<DbDriver>;
  /** Raw bytes of that copy. */
  readCopyBytes(): Promise<Uint8Array>;
  /** A well-formed but incorrect key. */
  readonly wrongKey: string;
  /** Values seeded into the DB before the probe; none may appear in the file bytes. */
  readonly plaintextMarkers: readonly string[];
}

export interface AtRestFinding {
  readonly check: string;
  readonly detail: string;
}

/** The 16-byte magic every unencrypted SQLite file starts with. A SQLCipher database
 * encrypts page 1 including the header, so finding this string means no encryption. */
const SQLITE_PLAINTEXT_HEADER = 'SQLite format 3';

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Opens the copy and forces a real page read.
 *
 * The `open()` call alone is not evidence: SQLCipher defers key verification to the first
 * page read, so a wrong-key open can appear to succeed and only fail on query. Reading
 * sqlite_master is what actually decides it.
 *
 * @returns a finding when the database WAS readable (which is the failure), else `null`.
 */
async function expectUnreadable(
  ctx: AtRestProbeContext,
  key: string | null,
  check: string,
): Promise<AtRestFinding | null> {
  let driver: DbDriver | undefined;
  try {
    driver = await ctx.openCopy(key);
    await driver.execute('SELECT count(*) AS c FROM sqlite_master');
    return { check, detail: 'the database file opened AND was readable — it is not ciphertext' };
  } catch {
    return null;
  } finally {
    await driver?.close().catch(() => undefined);
  }
}

/**
 * Runs the three SEC-DEV-06 assertions against a copy of the on-device database:
 * unkeyed open fails, wrong-key open fails, and the bytes carry no plaintext.
 *
 * @returns every failed check. An empty array means the DB at rest is ciphertext.
 */
export async function checkDbAtRestIsCiphertext(ctx: AtRestProbeContext): Promise<AtRestFinding[]> {
  const findings: AtRestFinding[] = [];

  const unkeyed = await expectUnreadable(ctx, null, 'open without key is refused');
  if (unkeyed) findings.push(unkeyed);

  const wrongKey = await expectUnreadable(ctx, ctx.wrongKey, 'open with wrong key is refused');
  if (wrongKey) findings.push(wrongKey);

  const bytes = await ctx.readCopyBytes();
  const encoder = new TextEncoder();

  if (indexOfBytes(bytes, encoder.encode(SQLITE_PLAINTEXT_HEADER)) !== -1) {
    findings.push({
      check: 'no plaintext SQLite header',
      detail: `file begins with the unencrypted "${SQLITE_PLAINTEXT_HEADER}" magic`,
    });
  }

  for (const marker of ctx.plaintextMarkers) {
    if (indexOfBytes(bytes, encoder.encode(marker)) !== -1) {
      findings.push({
        check: 'no seeded plaintext markers',
        detail: `seeded marker ${JSON.stringify(marker)} is readable in the file bytes`,
      });
    }
  }

  return findings;
}
