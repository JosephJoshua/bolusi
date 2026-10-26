// The op-log compressor (compression.ts): lossless, sized by its own header, and loud when the header
// and the body disagree. The cipher tests cover it sealed; these cover the framing on its own.
import { describe, expect, test } from 'vitest';

import { base64ToBytes, bytesToUtf8, utf8ToBytes } from '@bolusi/core';

import { compressValue, decompressValue } from '../src/crypto/compression.js';

describe('op-log compression', () => {
  test('round-trips empty, small and multi-header-byte values', () => {
    for (const text of ['', '{"payload":{}}', 'Yohanis — layar retak ✓', 'x'.repeat(300_000)]) {
      const bytes = utf8ToBytes(text);
      expect(decompressValue(compressValue(bytes))).toEqual(bytes);
    }
  });

  test('a header that disagrees with the body throws instead of returning a cut-short value', () => {
    const compressed = compressValue(utf8ToBytes('a'.repeat(1000)));
    // 1000 encodes as two header bytes, 0xe8 0x07. Claim 999 and then 1001.
    const shorter = Uint8Array.from(compressed);
    shorter[0] = 0xe7;
    expect(() => decompressValue(shorter)).toThrow(/header says 999/);
    const longer = Uint8Array.from(compressed);
    longer[0] = 0xe9;
    expect(() => decompressValue(longer)).toThrow(/header says 1001/);
  });

  test('a value compressed when the format was fixed still inflates (the dictionary is frozen)', () => {
    // Written once by compressValue and pasted here. If this fails, OP_LOG_DICTIONARY or the framing
    // changed, and every compressed op already on a device would stop reading.
    const stored = base64ToBytes(
      'Z8MbLpjuDSnNS08vVQBlIIWUxKJMBa/EysSC0qJEkEdQ7SnPL8qOL0gE2pWiVAsA',
    );
    expect(bytesToUtf8(decompressValue(stored))).toBe(
      '{"agentConversationId":null,"payload":{"note":"Tunggu part dari Jayapura"},"type":"repair.work_paused"}',
    );
  });

  test('an unterminated header throws', () => {
    expect(() => decompressValue(Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x01]))).toThrow(
      /no valid length header/,
    );
    expect(() => decompressValue(new Uint8Array(0))).toThrow(/no valid length header/);
  });
});
