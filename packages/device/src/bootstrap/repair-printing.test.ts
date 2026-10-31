// The phone's printing binding over a real client DB: names from this device, the remembered
// paper, verified pictures as data URIs, and the page routed to the platform.
import { PAPER_PRESETS, STORE_NAME_META_KEY, writeMeta } from '@bolusi/core';
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import type { ThumbnailLoader } from '@bolusi/modules/screen-kit';
import { nodeColumnAead } from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import {
  createRepairPrinting,
  PRINT_PAPER_META_KEY,
  type PrintPlatform,
} from './repair-printing.js';

const keyStore = { getDatabaseEncryptionKey: () => Promise.resolve('a'.repeat(64)) };
const LOGO = {
  kind: 'signed',
  mediaId: 'logo-1',
  sha256: 'f'.repeat(64),
  mime: 'image/png',
} as const;

let db: ClientDb;

beforeEach(async () => {
  await closeClientDb();
  db = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore,
    aead: nodeColumnAead,
    location: ':memory:',
  });
  await runClientMigrations(db.driver, { now: () => 1 });
});

afterEach(async () => {
  await closeClientDb();
});

function printing(load: ThumbnailLoader = () => Promise.resolve({ kind: 'unavailable' })) {
  const platform: PrintPlatform = {
    print: vi.fn(() => Promise.resolve('cancelled' as const)),
    sharePdf: vi.fn(() => Promise.resolve('done' as const)),
    readBase64: vi.fn(() => Promise.resolve('QUJD')),
  };
  return {
    platform,
    port: createRepairPrinting({ db: db.db, loadThumbnail: load, platform }),
  };
}

describe('the phone printing binding', () => {
  test('the store name is the enrolled one, empty before enrollment', async () => {
    const { port } = printing();
    expect(await port.storeName()).toBe('');
    await writeMeta(db.db, STORE_NAME_META_KEY, 'Bolusi Wamena');
    expect(await port.storeName()).toBe('Bolusi Wamena');
  });

  test('the paper is remembered, and a damaged value reads as none', async () => {
    const { port } = printing();
    expect(await port.readPaper()).toBeNull();
    await port.writePaper(PAPER_PRESETS.a5);
    expect(await port.readPaper()).toEqual(PAPER_PRESETS.a5);
    await writeMeta(db.db, PRINT_PAPER_META_KEY, '{"preset":"a5"');
    expect(await port.readPaper()).toBeNull();
    await writeMeta(db.db, PRINT_PAPER_META_KEY, '{"preset":"a5","widthMm":1}');
    expect(await port.readPaper()).toBeNull();
  });

  test('a picture prints only once its verified file is here', async () => {
    const waiting = printing();
    expect(await waiting.port.imageDataUri(LOGO)).toBeNull();
    const failing = printing(() => Promise.reject(new Error('gone')));
    expect(await failing.port.imageDataUri(LOGO)).toBeNull();
    const ready = printing(() =>
      Promise.resolve({ kind: 'ready', uri: 'file:///render/logo.png' }),
    );
    expect(await ready.port.imageDataUri(LOGO)).toBe('data:image/png;base64,QUJD');
    expect(ready.platform.readBase64).toHaveBeenCalledWith('file:///render/logo.png');
  });

  test('print goes to the dialog and share to the PDF, each with its own outcome', async () => {
    const { port, platform } = printing();
    const document = {
      jobName: 'Nota SV-1',
      header: { name: 'Toko', lines: [], logo: null },
      title: 'NOTA',
      reference: 'SV-1',
      meta: [],
      blocks: [],
      aside: [],
      closing: [],
      copies: [],
    };
    const slip = { html: '<p>x</p>', document, jobName: 'Nota SV-1', paper: PAPER_PRESETS.a4 };
    expect(await port.output(slip, 'print')).toBe('cancelled');
    expect(await port.output(slip, 'share')).toBe('done');
    expect(platform.print).toHaveBeenCalledWith(slip);
    expect(platform.sharePdf).toHaveBeenCalledWith(slip);
  });
});
