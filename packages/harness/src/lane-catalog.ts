// A handful of phone catalog models for the QA lanes. The real catalog is crawled into the server's
// Postgres and never reaches a harness server, so without these the lane app has nothing for the
// typo-tolerant model search, the brand fill, the colour chips or the photo preview to show.
//
// Ids, names and page paths are GSMArena's, so a lane row looks like a crawled one. Specs are typed
// in by hand and the photos are drawn here: no crawled content is copied into the repository.
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

import {
  createPhoneCatalogWriterOn,
  type DB,
  type ListedPhoneModel,
  type PhoneModelDetails,
} from '@bolusi/db-server';
import type { FakeClock } from '@bolusi/test-support';
import type { Kysely } from 'kysely';

interface LaneModel {
  readonly listed: Omit<ListedPhoneModel, 'photoUrl'>;
  readonly details: PhoneModelDetails;
  /** The drawn screen's colour, RGB. */
  readonly tint: readonly [number, number, number];
}

const model = (
  id: number,
  brand: string,
  name: string,
  pagePath: string,
  details: PhoneModelDetails,
  tint: readonly [number, number, number],
  kind: ListedPhoneModel['kind'] = 'phone',
): LaneModel => ({
  listed: { id, brand, name, kind, announcedYear: details.announcedYear, pagePath },
  details,
  tint,
});

export const LANE_CATALOG: readonly LaneModel[] = [
  model(
    12824,
    'Samsung',
    'Galaxy A55',
    'samsung_galaxy_a55-12824.php',
    {
      modelCodes: ['SM-A556B', 'SM-A556E'],
      announcedYear: 2024,
      specs: {
        displayType: 'Super AMOLED, 120Hz',
        displaySize: '6.6 inches',
        displayResolution: '1080 x 2340 pixels',
        os: 'Android 14, One UI 6.1',
        chipset: 'Exynos 1480 (4 nm)',
        internalMemory: '128GB 8GB RAM, 256GB 8GB RAM, 256GB 12GB RAM',
        cardSlot: 'microSDXC (uses shared SIM slot)',
        battery: 'Li-Ion 5000 mAh',
        charging: '25W wired',
        usb: 'USB Type-C 2.0',
        sim: 'Nano-SIM + eSIM',
        colors: 'Awesome Iceblue, Awesome Lilac, Awesome Navy, Awesome Lemon',
      },
    },
    [96, 140, 200],
  ),
  model(
    12637,
    'Samsung',
    'Galaxy A15',
    'samsung_galaxy_a15-12637.php',
    {
      modelCodes: ['SM-A155F'],
      announcedYear: 2023,
      specs: {
        displayType: 'Super AMOLED, 90Hz',
        displaySize: '6.5 inches',
        os: 'Android 14, One UI 6',
        chipset: 'Mediatek Helio G99 (6 nm)',
        internalMemory: '128GB 4GB RAM, 128GB 6GB RAM, 256GB 8GB RAM',
        battery: 'Li-Po 5000 mAh',
        charging: '25W wired',
        colors: 'Blue Black, Blue, Light Blue, Yellow',
      },
    },
    [40, 60, 120],
  ),
  model(
    12436,
    'Oppo',
    'A58 4G',
    'oppo_a58_4g-12436.php',
    {
      modelCodes: ['CPH2577'],
      announcedYear: 2023,
      specs: {
        displayType: 'IPS LCD, 90Hz',
        displaySize: '6.72 inches',
        chipset: 'Mediatek Helio G85 (12 nm)',
        internalMemory: '128GB 6GB RAM, 128GB 8GB RAM',
        battery: 'Li-Po 5000 mAh',
        charging: '33W wired',
        colors: 'Glowing Black, Dazzling Green',
      },
    },
    [40, 140, 100],
  ),
  model(
    12776,
    'Xiaomi',
    'Redmi Note 13',
    'xiaomi_redmi_note_13-12776.php',
    {
      modelCodes: ['23124RA7EO'],
      announcedYear: 2023,
      specs: {
        displayType: 'AMOLED, 120Hz',
        displaySize: '6.67 inches',
        chipset: 'Qualcomm SM6225 Snapdragon 685 (6 nm)',
        internalMemory: '128GB 6GB RAM, 256GB 8GB RAM',
        battery: 'Li-Po 5000 mAh',
        charging: '33W wired',
        colors: 'Midnight Black, Mint Green, Ice Blue, Ocean Sunset',
      },
    },
    [70, 170, 150],
  ),
  model(
    12689,
    'Xiaomi',
    'Redmi 13C',
    'xiaomi_redmi_13c-12689.php',
    {
      modelCodes: ['23100RN82L'],
      announcedYear: 2023,
      specs: {
        displaySize: '6.74 inches',
        chipset: 'Mediatek Helio G85 (12 nm)',
        internalMemory: '128GB 4GB RAM, 256GB 8GB RAM',
        battery: 'Li-Po 5000 mAh',
        colors: 'Midnight Black, Clover Green, Navy Blue, Glacier White',
      },
    },
    [60, 90, 70],
  ),
  model(
    11103,
    'Apple',
    'iPhone 13',
    'apple_iphone_13-11103.php',
    {
      modelCodes: ['A2633', 'A2482'],
      announcedYear: 2021,
      specs: {
        displayType: 'Super Retina XDR OLED',
        displaySize: '6.1 inches',
        os: 'iOS 15',
        chipset: 'Apple A15 Bionic (5 nm)',
        internalMemory: '128GB 4GB RAM, 256GB 4GB RAM, 512GB 4GB RAM',
        cardSlot: 'No',
        battery: 'Li-Ion 3240 mAh',
        usb: 'Lightning, USB 2.0',
        colors: 'Starlight, Midnight, Blue, Pink, Red, Green',
      },
    },
    [200, 80, 110],
  ),
  model(
    12617,
    'Samsung',
    'Galaxy Tab A9+',
    'samsung_galaxy_tab_a9+-12617.php',
    {
      modelCodes: ['SM-X210'],
      announcedYear: 2023,
      specs: {
        displaySize: '11.0 inches',
        chipset: 'Qualcomm SM6375 Snapdragon 695 5G (6 nm)',
        internalMemory: '64GB 4GB RAM, 128GB 8GB RAM',
        battery: 'Li-Po 7040 mAh',
        colors: 'Graphite, Silver, Navy',
      },
    },
    [110, 110, 120],
    'tablet',
  ),
];

/** One PNG chunk: length, type, data, CRC over type and data. */
function chunk(kind: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(kind, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A phone drawn as a dark rounded body with a tinted screen, on transparent ground. */
export function drawLanePhone(tint: readonly [number, number, number], tablet = false): Uint8Array {
  const [width, height] = tablet ? [200, 140] : [120, 200];
  const corner = 14;
  const bezel = 8;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4); // filter byte 0, then RGBA
    for (let x = 0; x < width; x += 1) {
      const dx = Math.max(corner - x, x - (width - 1 - corner), 0);
      const dy = Math.max(corner - y, y - (height - 1 - corner), 0);
      if (dx * dx + dy * dy > corner * corner) continue;
      const screen = x >= bezel && x < width - bezel && y >= bezel && y < height - bezel;
      const [r, g, b] = screen ? tint : [32, 34, 40];
      row.set([r, g, b, 255], 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Store {@link LANE_CATALOG} the way a crawl would: listed, then photo, then details. */
export async function seedLaneCatalog(server: {
  readonly db: Kysely<DB>;
  readonly clock: FakeClock;
}): Promise<number> {
  const writer = createPhoneCatalogWriterOn(server.db);
  const at = server.clock.now();
  await writer.saveListedModels(
    LANE_CATALOG.map(({ listed }) => ({ ...listed, photoUrl: null })),
    at,
  );
  for (const { listed, details, tint } of LANE_CATALOG) {
    const bytes = drawLanePhone(tint, listed.kind === 'tablet');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writer.savePhoto(listed.id, { sha256, mime: 'image/png', bytes }, at);
    await writer.saveDetails(listed.id, details, at);
  }
  return LANE_CATALOG.length;
}
