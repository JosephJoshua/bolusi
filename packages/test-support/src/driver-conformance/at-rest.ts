// SEC-DEV-06 "the sensitive DB columns at rest are ciphertext" — the L6 (on-device) leg
// (security-guide §6.5; 10-db §9.7).
//
// ── THIS PROBE WAS INVERTED BY D22 AND HAS BEEN REBUILT. READ BEFORE EDITING. ──────────────────
// It used to assert SQLCipher's whole-file guarantee: an unkeyed open is refused, a wrong-key open is
// refused, and the file does not begin with the `SQLite format 3` magic. **All three now fire on
// CORRECT behaviour.** D22 dropped SQLCipher (its OpenSSL made the Android APK unassemblable, task
// 148); the database file is deliberately a plaintext SQLite file that opens with no key, and
// confidentiality comes from application-layer AES-256-GCM over the signed-off COLUMNS. Left as it
// was, the first required emulator gate would have gone red on a healthy device announcing "DB at
// rest is NOT ciphertext" — a false confidentiality alarm inviting either panic or a "relax the
// gate" fix. Its unit test stayed green throughout because it fed fakes shaped to the dead model:
// a guard that could not see that its own premise had died.
//
// WHAT IT ASSERTS NOW:
//   1. none of the seeded plaintext markers survives anywhere in the raw file bytes;
//   2. every stored cell of every signed-off encrypted column carries the cipher's marker prefix;
//   3. COVERAGE — every one of those columns was actually observed. Without (3) a device that seeded
//      nothing would satisfy (1) and (2) vacuously, which is the failure mode §2.11 exists for: a
//      guard must assert its own denominator, not just the absence of bad news.
//
// The T-14b positive control (`checkControlSeedIsWitnessed`) is UNCHANGED and still required: absence
// of a marker is only evidence once the seed is proven to write marker bytes at all.
//
// Everything the probe touches is injected, because this package may not import a DB driver or a
// filesystem (08 §3.3) — including the marker prefix, so no db-client VALUE is imported here.

/** One stored cell of a signed-off encrypted column, read back from a copy of the device DB. */
export interface SealedCell {
  readonly table: string;
  readonly column: string;
  /** The value physically stored. `null` is legal for a nullable column and is not a finding. */
  readonly value: string | null;
}

export interface AtRestProbeContext {
  /** Raw bytes of a COPY of the device's DB file — never the live one (08 §2.2's one connection). */
  readCopyBytes(): Promise<Uint8Array>;
  /** Values seeded into the DB before the probe; none may appear in the file bytes. */
  readonly plaintextMarkers: readonly string[];
  /** Every stored cell of the encrypted columns, read from the copy (no key — the file is plain SQLite). */
  readSealedCells(): Promise<readonly SealedCell[]>;
  /**
   * The prefix every sealed value must carry. Injected rather than imported so this package keeps its
   * type-only edge to `@bolusi/db-client`; the device ctx passes `COLUMN_CIPHER_SCHEME_PREFIX`.
   */
  readonly sealedPrefix: string;
}

export interface AtRestFinding {
  readonly check: string;
  readonly detail: string;
}

/**
 * The signed-off encrypted set (D22 addendum 2; 10-db §9.7). The probe requires EVERY one of these to
 * be observed on the device — that is the coverage half of the gate. Adding a column to the encrypted
 * set without adding it here would leave the new column unprobed and the gate still green.
 */
export const AT_REST_ENCRYPTED_COLUMNS: readonly (readonly [table: string, column: string])[] = [
  ['operations', 'payload'],
  ['operations', 'signed_core_jcs'],
  ['operations', 'location'],
  ['notes', 'title'],
  ['notes', 'body'],
  ['user_pin_verifiers', 'salt'],
  ['user_pin_verifiers', 'hash'],
  ['user_pin_verifiers', 'params'],
  ['media_items', 'location'],
  ['quarantined_ops', 'signed_core_jcs'],
  ['users_directory', 'name'],
];

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
 * THE POSITIVE CONTROL for `checkDbAtRestIsCiphertext` (testing-guide T-14b).
 *
 * The seeded-marker check passes when the markers are ABSENT from the file — which is exactly what a
 * SILENT SEED NO-OP also produces. "No plaintext found" then proves nothing: it is the parse-collapse
 * / empty-fixture family (an empty result and a correct result look identical). So before the
 * on-device leg (task 27a) trusts a marker's absence from the real file, it writes the SAME markers to
 * a control DB with the cipher DISABLED and passes THAT copy's raw bytes here. A marker MISSING from
 * the control means the seed wrote nothing on this device, so the encrypted-file result is vacuous and
 * must not be believed. An empty array is the control PASSING.
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
          `is a silent no-op, so "no plaintext in the encrypted columns" would prove nothing (T-14b)`,
      });
    }
  }
  return findings;
}

/**
 * Runs the post-D22 SEC-DEV-06 assertions against a copy of the on-device database.
 *
 * @returns every failed check. An empty array means the protected columns at rest are ciphertext.
 */
export async function checkDbAtRestIsCiphertext(ctx: AtRestProbeContext): Promise<AtRestFinding[]> {
  const findings: AtRestFinding[] = [];
  const encoder = new TextEncoder();

  // 1. No seeded plaintext survives in the file. (The `SQLite format 3` header is EXPECTED now and is
  //    deliberately not checked — the file is plain SQLite by design; only the VALUES are sealed.)
  const bytes = await ctx.readCopyBytes();
  for (const marker of ctx.plaintextMarkers) {
    if (indexOfBytes(bytes, encoder.encode(marker)) !== -1) {
      findings.push({
        check: 'no seeded plaintext markers',
        detail: `seeded marker ${JSON.stringify(marker)} is readable in the file bytes`,
      });
    }
  }

  // 2. Every stored cell of an encrypted column is a marked blob.
  const cells = await ctx.readSealedCells();
  for (const cell of cells) {
    if (cell.value === null) continue;
    if (!cell.value.startsWith(ctx.sealedPrefix)) {
      findings.push({
        check: 'encrypted column is sealed',
        detail: `${cell.table}.${cell.column} is stored WITHOUT the cipher marker — it is plaintext`,
      });
    }
  }

  // 3. COVERAGE. Absence of bad news is only evidence if the probe actually looked. A device that
  //    seeded nothing would pass (1) and (2) trivially, so every signed-off column must have been
  //    observed with at least one non-null value.
  for (const [table, column] of AT_REST_ENCRYPTED_COLUMNS) {
    const observed = cells.some(
      (cell) => cell.table === table && cell.column === column && cell.value !== null,
    );
    if (!observed) {
      findings.push({
        check: 'every encrypted column was actually probed',
        detail:
          `${table}.${column} produced no non-null cell on this device — the seed did not populate ` +
          `it, so this run proves NOTHING about that column (a guard must assert its own coverage)`,
      });
    }
  }

  return findings;
}
