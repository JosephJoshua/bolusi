// The OpenSSL bench port reproduces the shared vectors byte-for-byte, like `noblePort` does.
import { bytesToHex, hexToBytes, utf8ToBytes } from '@bolusi/core';
import { describe, expect, it } from 'vitest';

import { opensslPort } from './openssl-port.js';
import { ed25519Vectors, sha256Vectors } from './vectors.js';

describe('opensslPort', () => {
  it.each(sha256Vectors)('reproduces the $name digest', ({ messageUtf8, digestHex }) => {
    expect(bytesToHex(opensslPort.sha256(utf8ToBytes(messageUtf8)))).toBe(digestHex);
  });

  it.each(ed25519Vectors)('signs and verifies $name byte-for-byte', (vector) => {
    const message = hexToBytes(vector.messageHex);
    const signature = opensslPort.sign(message, hexToBytes(vector.seedHex));
    expect(bytesToHex(signature)).toBe(vector.signatureHex);
    expect(opensslPort.verify(signature, message, hexToBytes(vector.publicKeyHex))).toBe(true);
    expect(
      opensslPort.verify(signature, utf8ToBytes('other'), hexToBytes(vector.publicKeyHex)),
    ).toBe(false);
  });

  it('returns false rather than throwing on a malformed key', () => {
    expect(opensslPort.verify(new Uint8Array(64), new Uint8Array(32), new Uint8Array(31))).toBe(
      false,
    );
  });
});
