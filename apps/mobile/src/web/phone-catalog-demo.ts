/**
 * A small phone catalog for the browser harness (repair-demo.ts), searched with the same shared
 * fuzzy index and the same identity rule (`catalogKeys`) the device uses.
 *
 * The pictures are drawn stand-ins, labelled as such: the harness cannot reach GSMArena, and a
 * real catalog photo here would pretend otherwise.
 */
import { FuzzyIndex } from '@bolusi/core';
import {
  catalogKeys,
  sameDeviceModel,
  type DeviceModelKind,
  type DeviceModelPhoto,
  type DeviceModelRow,
} from '@bolusi/modules/repair';

interface DemoModel {
  readonly id: number;
  readonly brand: string;
  readonly name: string;
  readonly year: number;
  readonly codes?: string;
  readonly kind?: DeviceModelKind;
  /** Body colour of the drawing; none means the catalog has no photo of it. */
  readonly body?: string;
}

const MODELS: readonly DemoModel[] = [
  {
    id: 12824,
    brand: 'Samsung',
    name: 'Galaxy A55',
    year: 2024,
    codes: 'SM-A556B, SM-A556E',
    body: '#c9d6e8',
  },
  {
    id: 12825,
    brand: 'Samsung',
    name: 'Galaxy A35',
    year: 2024,
    codes: 'SM-A356E',
    body: '#d9c8e6',
  },
  {
    id: 13603,
    brand: 'Samsung',
    name: 'Galaxy A56',
    year: 2025,
    codes: 'SM-A566B',
    body: '#9aa5b1',
  },
  {
    id: 12259,
    brand: 'Samsung',
    name: 'Galaxy A54',
    year: 2023,
    codes: 'SM-A546E',
    body: '#e7e2d6',
  },
  {
    id: 12458,
    brand: 'Samsung',
    name: 'Galaxy A05s',
    year: 2023,
    codes: 'SM-A057F',
    body: '#5b6672',
  },
  {
    id: 12040,
    brand: 'Samsung',
    name: 'Galaxy A14',
    year: 2023,
    codes: 'SM-A145F',
    body: '#3d4450',
  },
  {
    id: 13711,
    brand: 'Samsung',
    name: 'Galaxy Tab A9+',
    year: 2023,
    kind: 'tablet',
    body: '#8e98a3',
  },
  { id: 12589, brand: 'Xiaomi', name: 'Redmi Note 13', year: 2023, body: '#b9d4c8' },
  { id: 12600, brand: 'Xiaomi', name: 'Redmi 13C', year: 2023, body: '#5e7d6f' },
  { id: 12990, brand: 'Oppo', name: 'A58', year: 2023, body: '#e3c9a7' },
  { id: 12001, brand: 'Oppo', name: 'A57 4G', year: 2022, body: '#2f3b52' },
  { id: 12700, brand: 'Vivo', name: 'Y17s', year: 2023, body: '#7aa3c9' },
  { id: 12800, brand: 'Infinix', name: 'Hot 40 Pro', year: 2023, body: '#c7b46a' },
  { id: 13000, brand: 'Apple', name: 'iPhone 13', year: 2021, body: '#f2c6cf' },
  { id: 13001, brand: 'Apple', name: 'iPhone 11', year: 2019 },
  { id: 12900, brand: 'Realme', name: 'C55', year: 2023, body: '#e8d27a' },
];

/** Whether a compacted catalog spelling is what was typed. */
function sameKey(key: string, typed: { brand: string; model: string }): boolean {
  return sameDeviceModel({ brand: '', model: key }, typed);
}

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

/** Brand and model names as the store typed them before, as if learned from intakes. */
const LEARNED: readonly [string, string][] = [['Evercoss', 'Xtream 1 Plus']];

/** A drawn phone, front view, in the model's colour, marked as a stand-in. */
function drawing(model: DemoModel): string {
  const tablet = model.kind === 'tablet';
  const [w, h] = tablet ? [140, 190] : [92, 190];
  const x = (160 - w) / 2;
  const y = (212 - h) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="212" viewBox="0 0 160 212">
<defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#60a5fa"/></linearGradient></defs>
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${tablet ? 10 : 14}" fill="${model.body ?? '#999'}" stroke="#4b5563" stroke-width="1.5"/>
<rect x="${x + 5}" y="${y + 6}" width="${w - 10}" height="${h - 12}" rx="${tablet ? 6 : 10}" fill="url(#s)"/>
<circle cx="80" cy="${y + 14}" r="3" fill="#0b1020"/>
<text x="80" y="${y + h / 2}" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#fff" opacity="0.85">contoh</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function photoOf(model: DemoModel): DeviceModelPhoto | null {
  return model.body === undefined
    ? null
    : { modelId: model.id, sha256: model.id.toString(16).padStart(64, '0') };
}

function rowOf(model: DemoModel): DeviceModelRow {
  return {
    key: `c:${model.id}`,
    brand: model.brand,
    model: model.name,
    kind: model.kind ?? 'phone',
    announcedYear: model.year,
    photo: photoOf(model),
    learned: false,
  };
}

function learnedRow([brand, model]: [string, string]): DeviceModelRow {
  return {
    key: `l:${JSON.stringify([brand, model])}`,
    brand,
    model,
    kind: null,
    announcedYear: null,
    photo: null,
    learned: true,
  };
}

const INDEX = new FuzzyIndex([
  ...MODELS.map((m) => ({
    id: `c:${m.id}`,
    text: [m.brand, m.name],
    codes: m.codes === undefined ? [] : m.codes.split(','),
    rank: m.year,
  })),
  ...LEARNED.map((entry) => ({ id: learnedRow(entry).key, text: entry, rank: 2026 })),
]);

const ROWS = new Map<string, DeviceModelRow>([
  ...MODELS.map((m) => [`c:${m.id}`, rowOf(m)] as const),
  ...LEARNED.map((entry) => [learnedRow(entry).key, learnedRow(entry)] as const),
]);

export function demoSearchDeviceModels(text: string, limit: number): DeviceModelRow[] {
  return INDEX.search(text, limit)
    .map((hit) => ROWS.get(hit.id))
    .filter((row) => row !== undefined);
}

export function demoFindDeviceModel(brand: string, model: string): DeviceModelRow[] {
  // The device's rule: the same brand, and the typed name is one of the catalog's spellings.
  const wanted = { brand, model };
  const match = MODELS.filter((m) => m.brand.toLowerCase() === brand.trim().toLowerCase()).find(
    (m) => catalogKeys(m.brand, m.name).some((key) => sameKey(key, wanted)),
  );
  return match === undefined ? [] : [rowOf(match)];
}

export function demoModelPhoto(photo: DeviceModelPhoto): Promise<string | null> {
  const model = BY_ID.get(photo.modelId);
  return Promise.resolve(model?.body === undefined ? null : drawing(model));
}
