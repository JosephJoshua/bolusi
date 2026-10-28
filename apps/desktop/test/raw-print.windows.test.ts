// @vitest-environment node
// The real Windows spooler: a RAW job to a printer whose port is a file must come out byte for
// byte. CI's Windows job installs that printer and names it in BOLUSI_TEST_PRINTER and
// BOLUSI_TEST_PRINT_FILE; anywhere else this is skipped.
import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { sendRaw } from '../src/main/raw-print.js';

const printer = process.env['BOLUSI_TEST_PRINTER'];
const output = process.env['BOLUSI_TEST_PRINT_FILE'];

async function waitForFile(path: string, bytes: number): Promise<Buffer> {
  for (let i = 0; i < 100; i += 1) {
    const size = await stat(path).then(
      (s) => s.size,
      () => -1,
    );
    if (size >= bytes) return readFile(path);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${path} never got ${String(bytes)} bytes`);
}

describe.runIf(process.platform === 'win32' && printer !== undefined && output !== undefined)(
  'Windows spooler',
  () => {
    it('prints ESC/P bytes untouched as a RAW job', async () => {
      const bytes = new Uint8Array([
        0x1b,
        0x40,
        0x1b,
        0x78,
        0x00,
        ...new TextEncoder().encode('BOLUSI TEST\r\n'),
        0x0c,
      ]);
      expect(await sendRaw(printer!, bytes, 'Bolusi test')).toEqual({ ok: true });
      expect(new Uint8Array(await waitForFile(output!, bytes.length))).toEqual(bytes);
    }, 60_000);

    it('names a printer that is not installed', async () => {
      expect(await sendRaw('Bolusi no such printer', new Uint8Array([1]), 'x')).toEqual({
        ok: false,
        problem: 'printerMissing',
      });
    }, 60_000);
  },
);
