// Deflate for sealed values that opt in (`SealOptions.compress`, @bolusi/core).
//
// Only the op log opts in: its signed-core JSON is most of a device's database, and each op is a
// small JSON document whose key names repeat in every row. Deflating one op on its own leaves those
// names nearly uncompressed (a ~1 KB document has little to match against), so the compressor is
// primed with a preset dictionary of that repeated text. On the benchmark's repair history this takes
// the average signed core from 1,098 bytes to about 300, against 481 without the dictionary.
//
// THE DICTIONARY IS PART OF THE STORED FORMAT. Inflating needs the exact bytes deflate was primed
// with, so editing `OP_LOG_DICTIONARY` would make every compressed value already on a device
// unreadable. It is frozen; a better dictionary means a new scheme prefix in column-cipher.ts that
// readers recognise alongside this one.
import { deflateSync, inflateSync } from 'fflate';

import { utf8ToBytes } from '@bolusi/core';

/**
 * Text the op log repeats: key names and fixed values from the repair payloads (quote lines, the
 * intake form, media references) and, last, the signed core's envelope in JCS order (05 §2.1). No
 * real data. zlib favours matches near the end of the dictionary, so the envelope, which every op
 * carries, comes last.
 */
const OP_LOG_DICTIONARY = utf8ToBytes(
  '"amount":,"customerAgreed":true,"description":"","fromProposal":true,"kind":"part","lineId":"",' +
    '"reason":"","technicianId":"","handoverPhoto":{,"signature":{' +
    '"checklist":[{"item":"","note":"","state":"ok"}],"complaint":"","customerId":"",' +
    '"device":{"brand":"","color":"","imei":"","model":"","passcode":null},"estimatedReadyAt":null,' +
    '"intakeNotes":"","peripherals":["charger","case"],' +
    '"photos":{"back":{,"bottom":{,"front":{,"left":{,"right":{,"top":{' +
    '"capturedAt":,"deviceId":"","location":null,"mediaId":"","mime":"image/jpeg","sha256":"",' +
    '"sizeBytes":,"type":"image","userId":""},' +
    '{"agentConversationId":null,"agentInitiated":false,"deviceId":"","entityId":"",' +
    '"entityType":"repair_ticket","id":"","location":null,"payload":{"note":""},"previousHash":"",' +
    '"schemaVersion":1,"seq":,"source":"ui","storeId":"","tenantId":"","timestamp":,' +
    '"type":"repair.","userId":""}',
);

/**
 * The stored form is `varint(plaintext length) ‖ raw deflate`. Knowing the length lets inflate write
 * into one exactly sized buffer instead of growing a guessed one, which was most of its cost on a
 * small value (measured on Hermes: about 110 µs per op down to 85; on Node, 63 µs down to 10).
 */
export function compressValue(plaintext: Uint8Array): Uint8Array {
  const header = encodeLength(plaintext.length);
  const body = deflateSync(plaintext, { level: 6, dictionary: OP_LOG_DICTIONARY });
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

export function decompressValue(compressed: Uint8Array): Uint8Array {
  const { length, offset } = decodeLength(compressed);
  // One spare byte: fflate drops writes past the end of a caller's buffer, so an overlong result
  // would otherwise come back silently truncated to exactly `length`.
  const out = new Uint8Array(length + 1);
  const inflated = inflateSync(compressed.subarray(offset), { dictionary: OP_LOG_DICTIONARY, out });
  if (inflated.length !== length) {
    throw new Error(`compressed value inflated to ${inflated.length} bytes, header says ${length}`);
  }
  return inflated;
}

/** Unsigned LEB128: seven bits per byte, low group first, high bit set on every byte but the last. */
function encodeLength(length: number): Uint8Array {
  if (length >= 2 ** 28) throw new RangeError(`value too large to compress: ${length} bytes`);
  const bytes: number[] = [];
  let rest = length;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Uint8Array.from(bytes);
}

/** Lengths stay below 2^28 (four bytes); a longer or unterminated header is not one this wrote. */
function decodeLength(data: Uint8Array): { length: number; offset: number } {
  let length = 0;
  for (let index = 0; index < 4 && index < data.length; index += 1) {
    const byte = data[index]!;
    length += (byte & 0x7f) * 2 ** (7 * index);
    if ((byte & 0x80) === 0) return { length, offset: index + 1 };
  }
  throw new Error('compressed value has no valid length header');
}
