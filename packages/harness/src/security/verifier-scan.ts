// PIN-verifier leak detection — the scanner behind SEC-AUTH-09 leg 2 and invariant I-13
// ("PIN hash material never appears in the operation log or any op payload"; D11, api/02-auth §6.2).
//
// Modelled on `key-leak-scan.ts` (SEC-DEV-05) and for the same reason: a leak scan is only worth
// running if it would FIRE, so the encodings it looks for are enumerated explicitly and a positive
// control plants one. What it hunts is the SECRET half of the verifier record — the 16-byte salt
// and the 32-byte argon2id output. It deliberately does NOT flag the PARAMS (`mKiB`/`t`/`p`) or the
// `asOf` ref: those legitimately travel (the `verifierRef` naming the new verifier is the whole
// point of the D11 design), and flagging them would make the scan fire on correct payloads.
//
// The salt is scanned as well as the hash, and that is not belt-and-braces: a salt on the wire
// makes an offline dictionary attack precomputable against that one user, which is exactly the
// property per-user salts exist to deny (security-guide §5.2).

/** The secret half of a stored verifier record (api/02-auth §5.3). */
export interface VerifierSecrets {
  /** 16 CSPRNG bytes, base64. */
  readonly saltB64: string;
  /** 32-byte argon2id output, base64. */
  readonly hashB64: string;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function encodingsOf(base64: string): string[] {
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  if (bytes.length === 0) return [];
  const hex = toHex(bytes);
  return [
    base64,
    // base64url (some encoders): + → -, / → _, no padding.
    base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    // JSON-escaped base64: a `/` inside a JSON string may be written `\/`.
    base64.replace(/\//g, '\\/'),
    hex,
    hex.toUpperCase(),
  ].filter((encoding) => encoding.length > 0);
}

/** Every string form the salt or hash could plausibly appear as in a JSON body or a log line. */
export function verifierEncodings(verifier: VerifierSecrets): string[] {
  return [...new Set([...encodingsOf(verifier.saltB64), ...encodingsOf(verifier.hashB64)])];
}

/**
 * The encodings `text` leaks for ANY of `verifiers` (empty ⇒ no leak). Every verifier the cycle
 * produced is passed at once — T-14's whole-set discipline: scanning only the final verifier would
 * miss a superseded one that the change op carried, which is the exact material an append-only log
 * can never rotate out.
 */
export function leakedVerifierEncodings(
  text: string,
  verifiers: readonly VerifierSecrets[],
): string[] {
  const found: string[] = [];
  for (const verifier of verifiers) {
    for (const encoding of verifierEncodings(verifier)) {
      if (text.includes(encoding)) found.push(encoding);
    }
  }
  return [...new Set(found)];
}
