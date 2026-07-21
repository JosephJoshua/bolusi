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
 * THE POSITIVE CONTROL for `checkDbAtRestIsCiphertext` (testing-guide T-14b).
 *
 * The seeded-marker check below passes when the markers are ABSENT from the file — which is exactly
 * what a SILENT SEED NO-OP also produces. "No plaintext found" then proves nothing: it is the
 * parse-collapse / empty-fixture family (an empty result and a correct result look identical). So
 * before the on-device leg (task 27a) trusts a marker's absence from the SQLCipher file, it writes
 * the SAME markers to an UNENCRYPTED control DB and passes THAT copy's raw bytes here. A marker
 * MISSING from the control means the seed wrote nothing on this device, so the encrypted-file result
 * is vacuous and must not be believed. An empty array is the control PASSING: the seed provably
 * lands marker bytes on disk, so their absence in ciphertext is real evidence.
 *
 * @returns a finding for every marker absent from the control bytes. Empty ⇒ the seed is witnessed.
 */
export function checkControlSeedIsWitnessed(
  controlBytes: Uint8Array,
  markers: readonly string[],
): AtRestFinding[] {
  const findings: AtRestFinding[] = [];
  const encoder = new TextEncoder();
  for (const marker of markers) {
    if (indexOfBytes(controlBytes, encoder.encode(marker)) === -1) {
      findings.push({
        check: 'positive control: seeded marker present in the unencrypted control DB',
        detail:
          `seeded marker ${JSON.stringify(marker)} is ABSENT from the control DB bytes — the seed ` +
          `is a silent no-op, so "no plaintext in the SQLCipher file" would prove nothing (T-14b)`,
      });
    }
  }
  return findings;
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
