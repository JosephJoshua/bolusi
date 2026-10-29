// A print call that never settles must not stop printing: expo-print's own wrapper refused every
// later print while one was pending, so one hung dialog meant "Terjadi kesalahan" until restart.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({ print: vi.fn<(options: unknown) => Promise<void>>() }));
const printToFileAsync = vi.hoisted(() => vi.fn<(options: unknown) => Promise<{ uri: string }>>());

vi.mock('expo', () => ({ requireNativeModule: () => native }));
vi.mock('expo-print', () => ({
  Orientation: { portrait: 'portrait', landscape: 'landscape' },
  printAsync: vi.fn(() => {
    throw new Error('the wrapper must not be used');
  }),
  printToFileAsync,
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(async () => true),
  shareAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-file-system', () => {
  class File {
    exists = false;
    uri = 'file:///cache/slips/nota.pdf';
    delete(): void {}
    async move(): Promise<void> {}
    base64(): Promise<string> {
      return Promise.resolve('');
    }
  }
  class Directory {
    exists = true;
    create(): void {}
  }
  return { File, Directory, Paths: { cache: '/cache' } };
});

import { Platform } from 'react-native';

import { PrinterProblem, type SlipOutput } from '@bolusi/modules/repair/screens';

import { expoPrintPlatform, PRINT_READY_TIMEOUT_MS } from './print.js';

const slip = {
  html: '<p>Nota</p>',
  jobName: 'Nota servisan SV-0001',
  paper: { widthMm: 148, heightMm: 210 },
} as unknown as SlipOutput;

const setOS = (os: 'android' | 'ios'): void => {
  (Platform as { OS: string }).OS = os;
};

beforeEach(() => {
  vi.useFakeTimers();
  native.print.mockReset();
  printToFileAsync.mockReset();
  setOS('android');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('print on Android', () => {
  test('a call that never settles gives up as stuck, and the next print still works', async () => {
    native.print.mockReturnValueOnce(new Promise(() => undefined));
    const first = expoPrintPlatform.print(slip);
    const settled = expect(first).rejects.toEqual(new PrinterProblem('stuck'));
    await vi.advanceTimersByTimeAsync(PRINT_READY_TIMEOUT_MS);
    await settled;

    native.print.mockResolvedValueOnce(undefined);
    await expect(expoPrintPlatform.print(slip)).resolves.toBe('unconfirmed');
    expect(native.print).toHaveBeenCalledTimes(2);
  });

  test('a dialog that opens in time is unconfirmed and leaves no timer behind', async () => {
    native.print.mockResolvedValueOnce(undefined);
    await expect(expoPrintPlatform.print(slip)).resolves.toBe('unconfirmed');
    expect(vi.getTimerCount()).toBe(0);
    expect(native.print).toHaveBeenCalledWith(
      expect.objectContaining({
        html: slip.html,
        width: 420,
        height: 595,
        orientation: 'portrait',
      }),
    );
  });

  test('a native failure still reaches the screen', async () => {
    native.print.mockRejectedValueOnce(new Error('PrintManager missing'));
    await expect(expoPrintPlatform.print(slip)).rejects.toThrow('PrintManager missing');
  });
});

describe('print on iOS', () => {
  test('waits for the dialog however long it stays open', async () => {
    setOS('ios');
    let close!: () => void;
    native.print.mockReturnValueOnce(new Promise<void>((resolve) => (close = resolve)));
    const printing = expoPrintPlatform.print(slip);
    await vi.advanceTimersByTimeAsync(PRINT_READY_TIMEOUT_MS * 4);
    close();
    await expect(printing).resolves.toBe('done');
  });

  test('a dialog closed without printing is cancelled', async () => {
    setOS('ios');
    native.print.mockRejectedValueOnce(
      Object.assign(new Error('x'), { code: 'ERR_PRINT_INCOMPLETE' }),
    );
    await expect(expoPrintPlatform.print(slip)).resolves.toBe('cancelled');
  });
});

describe('share as PDF', () => {
  test('a PDF that never gets written gives up as stuck', async () => {
    setOS('ios');
    printToFileAsync.mockReturnValueOnce(new Promise(() => undefined));
    const sharing = expoPrintPlatform.sharePdf(slip);
    const settled = expect(sharing).rejects.toEqual(new PrinterProblem('stuck'));
    await vi.advanceTimersByTimeAsync(PRINT_READY_TIMEOUT_MS);
    await settled;
  });
});
