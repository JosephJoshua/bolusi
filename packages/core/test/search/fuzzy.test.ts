// Fuzzy search: the spellings, typos and number formats staff actually type, shown on the shapes
// repair indexes (customers, and tickets with phone, IMEI and ticket number).
import { describe, expect, test } from 'vitest';

import {
  alignDistance,
  codeScore,
  compileQuery,
  digitScore,
  foldWord,
  FuzzyIndex,
  hasExactCode,
  normalizePhone,
  prepareDocument,
  scoreDocument,
  type SearchDocument,
} from '../../src/search/index.js';
import { digitTolerance } from '../../src/search/fuzzy.js';

interface Customer {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
}

interface Ticket extends Customer {
  readonly ticketNumber: string;
  readonly deviceBrand: string;
  readonly deviceModel: string;
  readonly deviceImei: string | null;
  readonly createdAt: number;
}

const customerDoc = (c: Customer, rank = 0): SearchDocument => ({
  id: c.id,
  text: [c.name],
  phones: [c.phone],
  rank,
});

const ticketDoc = (t: Ticket): SearchDocument => ({
  id: t.id,
  text: [t.name, t.deviceBrand, t.deviceModel],
  phones: [t.phone],
  numbers: [t.deviceImei],
  codes: [t.ticketNumber],
  rank: t.createdAt,
});

/** Search through the index, and check it agrees with scoring every document. */
function search(docs: readonly SearchDocument[], query: string): { id: string }[] {
  const hits = new FuzzyIndex(docs).search(query, 20);
  const compiled = compileQuery(query);
  const exact =
    compiled === null ? [] : docs.filter((doc) => hasExactCode(compiled, prepareDocument(doc)));
  const scanned = (exact.length > 0 ? exact : docs)
    .map((doc) => ({ doc, score: compiled === null ? 0 : scoreDocument(compiled, doc) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.doc.rank - a.doc.rank || (a.doc.id < b.doc.id ? -1 : 1))
    .slice(0, 20)
    .map((hit) => hit.doc.id);
  expect(hits.map((hit) => hit.id)).toEqual(scanned);
  return hits;
}

const searchCustomers = (rows: readonly Customer[], query: string) =>
  search(
    rows.map((row, i) => customerDoc(row, -i)),
    query,
  );
const searchTickets = (rows: readonly Ticket[], query: string) =>
  search(rows.map(ticketDoc), query);

const customers = [
  { id: 'c1', name: 'Yohanis Wenda', phone: '0812-4455-6677' },
  { id: 'c2', name: 'Soekarno Mandacan', phone: '+62 813 1111 2222' },
  { id: 'c3', name: 'Fransiskus Kogoya', phone: null },
  { id: 'c4', name: 'Hanna Rumbiak', phone: '6285233334444' },
  { id: 'c5', name: 'Achmad Djoko', phone: '081299990000' },
  { id: 'c6', name: 'Siti Fatimah', phone: null },
];

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

describe('customer search', () => {
  test.each([
    ['Johanis', 'c1'], // old j spelling
    ['yohanes', 'c1'], // e/i vowel typo
    ['YOHAN', 'c1'], // partial, any case
    ['wnda', 'c1'], // missing letter
    ['Sukarno', 'c2'], // oe → u
    ['frans', 'c3'], // short form prefix
    ['Hana', 'c4'], // doubled letter
    ['Ahmad Joko', 'c5'], // ch → h, dj → j, both words
    ['Fatima', 'c6'], // trailing h
    ['yohnais', 'c1'], // swapped letters
    ['wedna', 'c1'], // swapped letters in a short word
    ['Mandacam', 'c2'], // wrong letter
    ['kogoyaa', 'c3'], // extra letter
    ['rumbiek', 'c4'], // wrong vowel
    ['ahmd djko', 'c5'], // letters dropped in both words
    ['fransiskos kogoya', 'c3'], // typo in a full name
    ['rum biak', 'c4'], // split differently from how it was stored
    ['tima', 'c6'], // inside a longer word
    ['hannna', 'c4'], // a key held too long
    ['yoh', 'c1'], // still being typed: the h is not the trailing h of Fatimah, so not Djoko
  ])('%s finds %s first', (query, expected) => {
    expect(ids(searchCustomers(customers, query))[0]).toBe(expected);
  });

  test('every word must match: "yohanis kogoya" finds nobody', () => {
    expect(searchCustomers(customers, 'yohanis kogoya')).toEqual([]);
  });

  test.each([
    ['6677', 'c1'], // last digits
    ['081244556677', 'c1'], // full local number without separators
    ['+62 812 4455 6677', 'c1'], // international form
    ['6281311112222', 'c2'],
    ['0852 3333 4444', 'c4'], // stored as 62…, typed as 08…
  ])('phone %s finds %s', (query, expected) => {
    expect(ids(searchCustomers(customers, query))).toEqual([expected]);
  });

  test.each([
    ['081244556678', 'c1'], // one wrong digit
    ['081244565677', 'c1'], // two digits swapped
    ['08124455677', 'c1'], // a digit dropped
    ['0813 1111 2223', 'c2'],
  ])('a misremembered phone %s still finds %s first', (query, expected) => {
    expect(ids(searchCustomers(customers, query))[0]).toBe(expected);
  });

  test('closer matches rank above looser ones', () => {
    const rows = [
      { id: 'near', name: 'Yohanes', phone: null },
      { id: 'exact', name: 'Yohanis', phone: null },
      { id: 'prefix', name: 'Yohanisa', phone: null },
    ];
    expect(ids(searchCustomers(rows, 'yohanis'))).toEqual(['exact', 'prefix', 'near']);
  });

  test('short digit lookups stay strict so the last four digits do not match everyone', () => {
    expect(searchCustomers(customers, '6678')).toEqual([]);
  });

  test('empty and unrelated queries return nothing', () => {
    expect(searchCustomers(customers, '   ')).toEqual([]);
    expect(searchCustomers(customers, 'xylophone')).toEqual([]);
  });

  test('normalizePhone and foldWord', () => {
    expect(normalizePhone('+62 812-345')).toBe('0812345');
    expect(normalizePhone('812345678')).toBe('0812345678');
    expect(foldWord('johannes')).toBe(foldWord('yohanes'));
    expect(foldWord('rocky')).toBe(foldWord('roky'));
    expect(foldWord('riyanto')).toBe(foldWord('rianto'));
    expect(foldWord('mariyam')).toBe(foldWord('maryam'));
    expect(foldWord('alexsander')).toBe(foldWord('aleksander'));
    expect(foldWord('jacqueline')).toBe(foldWord('jaqueline'));
    expect(foldWord('2024')).toBe('2024');
  });

  test('folds squeeze a pair, never a longer run or down to a word of one or two letters', () => {
    expect(foldWord('zzzz')).toBe('zzzz');
    expect(foldWord('yyyy')).toBe('iiii');
    expect(foldWord('qx')).toBe('kks');
    expect(foldWord('qq')).toBe('kk');
  });
});

describe('ticket search', () => {
  const ticket = (overrides: Partial<Ticket> & { id: string }): Ticket => ({
    name: 'Yohanis Wenda',
    phone: '0812-4455-6677',
    ticketNumber: 'K7Q-0042',
    deviceBrand: 'Samsung',
    deviceModel: 'Galaxy A14',
    deviceImei: '356789104455667',
    createdAt: 1,
    ...overrides,
  });
  const tickets = [
    ticket({ id: 't1' }),
    ticket({
      id: 't2',
      ticketNumber: 'K7Q-0043',
      name: 'Hanna Rumbiak',
      phone: null,
      deviceBrand: 'Oppo',
      deviceModel: 'A57',
      deviceImei: null,
      createdAt: 2,
    }),
    ticket({ id: 't3', ticketNumber: 'M2X-0001', createdAt: 3, deviceModel: 'Galaxy A05' }),
  ];
  const withXiaomi = [
    ...tickets,
    ticket({
      id: 't4',
      ticketNumber: 'M2X-0002',
      name: 'Elias Mofu',
      phone: null,
      deviceBrand: 'Xiaomi',
      deviceModel: 'Redmi Note 13',
      deviceImei: null,
      createdAt: 4,
    }),
  ];

  test('ticket number with or without the dash, any case', () => {
    expect(ids(searchTickets(tickets, 'k7q-0043'))[0]).toBe('t2');
    expect(ids(searchTickets(tickets, 'K7Q0043'))[0]).toBe('t2');
    expect(ids(searchTickets(tickets, '0043'))[0]).toBe('t2');
  });

  test('a ticket number still being typed', () => {
    expect(ids(searchTickets(tickets, 'K7Q'))).toEqual(['t2', 't1']);
    expect(ids(searchTickets(tickets, 'k7q-00'))).toEqual(['t2', 't1']);
    expect(ids(searchTickets(tickets, 'K7Q-004'))).toEqual(['t2', 't1']);
    expect(ids(searchTickets(tickets, 'm2x'))).toEqual(['t3']);
    // The whole number typed right is that servisan alone, not its neighbours too.
    expect(ids(searchTickets(tickets, 'K7Q-0042'))).toEqual(['t1']);
    expect(ids(searchTickets(tickets, 'k7q0042'))).toEqual(['t1']);
    // The start must be typed right, or one wrong digit lists the neighbouring counters too.
    expect(searchTickets(tickets, 'K7R')).toEqual([]);
    expect(searchTickets(tickets, 'K7R-00')).toEqual([]);
  });

  test('ticket number typos: a wrong character, O for 0, swapped digits', () => {
    expect(ids(searchTickets(tickets, 'K7Q-0034'))[0]).toBe('t2');
    expect(ids(searchTickets(tickets, 'K7Q-OO43'))[0]).toBe('t2');
    expect(ids(searchTickets(tickets, 'M2K-0001'))[0]).toBe('t3');
  });

  test('model, brand and name typos', () => {
    expect(ids(searchTickets(tickets, 'opo a75'))).toEqual(['t2']);
    expect(ids(searchTickets(tickets, 'samsong galaxi'))).toEqual(['t3', 't1']);
    expect(ids(searchTickets(tickets, 'galaxya05'))[0]).toBe('t3');
    expect(ids(searchTickets(tickets, 'hana rumbak'))).toEqual(['t2']);
  });

  test('an IMEI with one wrong digit', () => {
    expect(ids(searchTickets(tickets, '356789104455668'))).toEqual(['t3', 't1']);
  });

  test('model and brand words', () => {
    expect(ids(searchTickets(tickets, 'oppo a57'))).toEqual(['t2']);
    expect(ids(searchTickets(tickets, 'galaxy a05'))[0]).toBe('t3');
  });

  test('IMEI digits', () => {
    expect(ids(searchTickets(tickets, '35678910'))).toEqual(['t3', 't1']);
  });

  test.each([
    ['samsng a1', 't1'], // a dropped letter, the model still being typed
    ['samsung galaxi a05', 't3'],
    ['galaxya1', 't1'], // typed together, still being typed
    ['oppo a5', 't2'],
    ['xiomi', 't4'],
    ['xiaomi redmi not 13', 't4'],
    ['redminote', 't4'],
    ['elias mofu', 't4'],
    ['elis', 't4'], // a dropped letter in a short name
    ['yohn', 't3'], // four letters with a typo, still being typed
    ['galaxy a 14', 't1'], // typed apart
    ['red mi', 't4'],
  ])('real typos still match: %s finds %s first', (query, expected) => {
    expect(ids(searchTickets(withXiaomi, query))[0]).toBe(expected);
  });

  // A few letters with a typo, or letters the spelling folds squeezed away, used to match whole
  // brands: "zzzzqx" listed every Xiaomi on the board.
  test.each([
    'zzzzqx',
    'qx',
    'kx',
    'xyz',
    'abc',
    'zzx',
    'hhhh',
    'aaaa',
    'qqq',
    'iiii',
    'qwqw',
    'lkjh',
    // A real word does not carry a stray one along.
    'samsung abc',
    'galaxy zz',
    'xiaomi qq',
  ])('nonsense %s finds nothing', (query) => {
    expect(searchTickets(withXiaomi, query)).toEqual([]);
  });

  test('equal matches come back newest first', () => {
    expect(ids(searchTickets(tickets, 'yohanis'))).toEqual(['t3', 't1']);
  });
});

describe('number scores stop early without changing a score', () => {
  // The definitions before the shortcut: every alignment scored, the best kept.
  const closeness = (edits: number, length: number) => 1 - edits / (length + 1);
  function fullDigitScore(query: string, stored: string): number {
    if (stored === '') return 0;
    if (query === stored) return 1;
    const tolerance = digitTolerance(query.length);
    let best = 0;
    const whole = alignDistance(query, stored, 'whole', tolerance);
    if (whole <= tolerance) best = 0.95 * closeness(whole, query.length);
    const suffix = alignDistance(query, stored, 'suffix', tolerance);
    if (suffix <= tolerance) best = Math.max(best, 0.85 * closeness(suffix, query.length));
    const infix = alignDistance(query, stored, 'infix', tolerance);
    if (infix <= tolerance) best = Math.max(best, 0.7 * closeness(infix, query.length));
    return best;
  }
  function fullCodeScore(query: string, stored: string): number {
    if (query.length < 3 || stored === '') return 0;
    if (query === stored) return 1;
    const tolerance = digitTolerance(query.length);
    let best = 0;
    const whole = alignDistance(query, stored, 'whole', tolerance);
    if (whole <= tolerance) best = 0.95 * closeness(whole, query.length);
    const suffix = alignDistance(query, stored, 'suffix', tolerance);
    if (suffix <= tolerance) best = Math.max(best, 0.8 * closeness(suffix, query.length));
    if (query.length < stored.length && stored.startsWith(query)) {
      best = Math.max(best, 0.7 + 0.15 * (query.length / stored.length));
    }
    return best;
  }

  test('on phones, IMEIs and codes typed with typos, swaps and partial digits', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const digits = (n: number) =>
      Array.from({ length: n }, () => String(Math.floor(random() * 10))).join('');
    // A part of the stored value with up to two random edits, or an unrelated number.
    const typed = (stored: string): string => {
      if (random() < 0.3) return digits(3 + Math.floor(random() * 10));
      const start = Math.floor(random() * (stored.length - 3));
      let out = stored.slice(start, start + 3 + Math.floor(random() * (stored.length - start)));
      for (let edit = Math.floor(random() * 3); edit > 0; edit -= 1) {
        const at = Math.floor(random() * out.length);
        out =
          random() < 0.5
            ? out.slice(0, at) + digits(1) + out.slice(at + 1)
            : out.slice(0, at) + out.slice(at + 1);
      }
      return out;
    };
    for (let i = 0; i < 5000; i += 1) {
      const stored = random() < 0.5 ? `08${digits(10)}` : digits(15);
      const query = typed(stored);
      expect(digitScore(query, stored)).toBe(fullDigitScore(query, stored));
      const code = `k7q${digits(4)}`;
      const codeQuery = typed(code);
      expect(codeScore(codeQuery, code)).toBe(fullCodeScore(codeQuery, code));
    }
  });
});
