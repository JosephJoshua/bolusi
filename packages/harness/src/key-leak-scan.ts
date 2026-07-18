// Private-key leak detection for SEC-DEV-05 (security-guide §219). The FaultFetch wrapper (§3.5) is
// the only surface that sees every outbound request; this scans a captured text for the device's
// 32-byte RFC-8032 private seed in any encoding it could plausibly leak as. It deliberately does
// NOT flag the PUBLIC key — `devicePublicKeyB64` legitimately rides in the genesis payload — so the
// scan must be scoped to the SECRET.
import { bytesToBase64 } from '@bolusi/core';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Every string encoding the private seed could appear as in a JSON body or a log line. */
export function privateKeyEncodings(seed: Uint8Array): string[] {
  const hex = toHex(seed);
  const b64 = bytesToBase64(seed);
  return [
    hex,
    hex.toUpperCase(),
    b64,
    // base64url (some encoders): + → -, / → _, no padding.
    b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  ];
}

/** The encodings a text leaks the private seed as (empty ⇒ no leak). Substring match, T-14 whole-set. */
export function leakedEncodings(text: string, seed: Uint8Array): string[] {
  return privateKeyEncodings(seed).filter((enc) => enc.length > 0 && text.includes(enc));
}
