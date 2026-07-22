// Connection-scoped at-rest column cipher (security-guide §6.4/§6.5; D22 + addendum 2).
//
// ── WHAT THIS IS, AND WHY IT LIVES IN CORE ──────────────────────────────────────────────────────
// D22 re-homed the client DB's at-rest encryption OFF SQLCipher (which vendored a second `libcrypto`
// that broke the Android APK — task 148) and ONTO application-layer AES-256-GCM on the sensitive
// COLUMNS, using quick-crypto's already-linked OpenSSL. The *implementation* of that AEAD lives in
// `@bolusi/db-client` (it holds the key and the base64/nonce framing). This file is the SEAM the
// rest of the code touches:
//
//   - The `ColumnCipher` INTERFACE — platform-free, so core can name the capability without
//     importing db-client (08 §3.3: core imports only kysely types + @bolusi/schemas).
//   - A CONNECTION-SCOPED registry (`WeakMap` keyed on the Kysely handle). `openClientDb` registers
//     the production connection's cipher; the raw-`sql` writers that persist an encrypted column
//     (pull `operations`, `user_pin_verifiers`, `users_directory`, `quarantined_ops`, `media_items`)
//     read it back through `encryptColumnValue(db, value)` and encrypt BEFORE the value is bound.
//
// ── WHY A REGISTRY AND NOT AN ARGUMENT / A GLOBAL ───────────────────────────────────────────────
// These writers are `<DB>`-generic raw-`sql` helpers (they run on client SQLite *and*, for the ops
// that exist there, would run on server PG) and cannot import the client schema type, so a Kysely
// query-builder INSERT (which a plugin could transform structurally) is not available to them — they
// MUST hand the value to `sql\`\`` already-encrypted. Threading a cipher argument down every call
// chain (enrollment → applyBundle → writeVerifier; the sync loop → pull → insertPulledOp) would
// touch dozens of contended call sites and every test harness. Instead the cipher rides WITH THE
// CONNECTION: exactly the connections that installed the decrypt plugin (production, and the
// adversarial at-rest tests) also register a cipher, so exactly those connections encrypt. A test
// harness that opens a bare Kysely registers nothing, `encryptColumnValue` passes the value through
// UNCHANGED, and the harness stores/reads plaintext exactly as before this change — no harness edits,
// no signature churn, and NO ambient global that could bleed one connection's key into another
// (the `WeakMap` is per-connection and collected with it).
//
// ── FAIL-SAFE DIRECTION ─────────────────────────────────────────────────────────────────────────
// The pass-through-when-absent default is the ONE place a mistake could store plaintext where
// ciphertext was intended, so it is guarded at the OTHER end: `openClientDb` refuses to open the
// production DB without a key (SEC-DEV-06), and the adversarial raw-file test (harness) enumerates
// all 11 signed-off columns and reds if any is stored in the clear. A guard is only load-bearing
// once it has been watched go red (CLAUDE.md §2.11) — that test is the one that watches this.

/**
 * The at-rest value cipher for a single client DB connection. Implemented by
 * `@bolusi/db-client`'s AES-256-GCM codec; named here so core stays platform-free.
 *
 * `encrypt`/`decrypt` operate on the TEXT column's string value. A stored value is
 * `<marker> ‖ base64(nonce ‖ ciphertext ‖ tag)`; `isCiphertext` recognises the marker so the
 * decrypt seam can pass plaintext columns through untouched and only ever attempt to decrypt what
 * this cipher produced.
 */
export interface ColumnCipher {
  /** Seal a plaintext column value. A value that is already ciphertext is returned unchanged. */
  encrypt(plaintext: string): string;
  /** Open a sealed value. MUST throw on a wrong key or a tampered blob — never return plaintext. */
  decrypt(stored: string): string;
  /** True iff `value` is a string this cipher produced (carries the marker + a structurally valid blob). */
  isCiphertext(value: unknown): value is string;
}

/**
 * Per-connection cipher store. Keyed on the Kysely handle the writers already hold, so lookup needs
 * no extra argument and no global. `WeakMap` so a closed connection's cipher is collectable.
 */
const CIPHERS = new WeakMap<object, ColumnCipher>();

/** Bind `cipher` to `connection` (the client Kysely handle). Called once by `openClientDb`. */
export function registerColumnCipher(connection: object, cipher: ColumnCipher): void {
  CIPHERS.set(connection, cipher);
}

/**
 * Encrypt a nullable TEXT column value for storage on `connection`.
 *
 * `null` stays `null` (a null column is not sensitive — its NULLness is already visible in the file's
 * structure, and encrypting it would break `IS NULL` predicates on plaintext-nullable columns like
 * `operations.location` / `media_items.location`). When the connection registered no cipher, the
 * value passes through UNCHANGED — see the file header for why that is the harness-safe default and
 * where it is guarded.
 */
export function encryptColumnValue(connection: object, value: string | null): string | null {
  if (value === null) return null;
  const cipher = CIPHERS.get(connection);
  return cipher === undefined ? value : cipher.encrypt(value);
}
