// A QR code as runs of dark modules, shared by the phone's and the PC's QrCode so both draw the same
// code for the same text: medium error correction, with the 4-module quiet zone scanners need.
import { encode } from 'uqr';

/** A horizontal run of dark modules in one row. */
export interface QrRun {
  readonly x: number;
  readonly y: number;
  readonly length: number;
}

export interface QrModules {
  /** Modules per side, quiet zone included. */
  readonly size: number;
  readonly runs: readonly QrRun[];
}

export function qrModules(value: string): QrModules {
  const { data } = encode(value, { ecc: 'M', border: 4 });
  const runs: QrRun[] = [];
  data.forEach((row, y) => {
    let start = -1;
    row.forEach((dark, x) => {
      if (dark && start < 0) start = x;
      if (start >= 0 && (!dark || x === row.length - 1)) {
        const end = dark ? x + 1 : x;
        runs.push({ x: start, y, length: end - start });
        start = -1;
      }
    });
  });
  return { size: data.length, runs };
}
