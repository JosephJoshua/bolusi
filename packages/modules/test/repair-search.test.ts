// Ticket and customer search: the spellings, typos and phone formats staff actually type.
import { describe, expect, test } from 'vitest';

import {
  foldWord,
  normalizePhone,
  searchCustomers,
  searchTickets,
  type SearchableTicket,
} from '../src/repair/search.js';
import { deviceCode, formatTicketNumber, ticketCounter } from '../src/repair/ticket-number.js';

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
    expect(foldWord('2024')).toBe('2024');
  });
});

describe('ticket search', () => {
  const ticket = (overrides: Partial<SearchableTicket> & { id: string }) => ({
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

  test('ticket number with or without the dash, any case', () => {
    expect(ids(searchTickets(tickets, 'k7q-0043'))[0]).toBe('t2');
    expect(ids(searchTickets(tickets, 'K7Q0043'))[0]).toBe('t2');
    expect(ids(searchTickets(tickets, '0043'))[0]).toBe('t2');
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

  test('equal matches come back newest first', () => {
    expect(ids(searchTickets(tickets, 'yohanis'))).toEqual(['t3', 't1']);
  });
});

describe('ticket numbers', () => {
  const device = '01920000-0000-7000-8000-00000000d00a';

  test('device code is 3 unambiguous characters and stable', () => {
    const code = deviceCode(device);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}$/);
    expect(deviceCode(device)).toBe(code);
  });

  test('devices enrolled in the same millisecond still get different codes', () => {
    expect(deviceCode('01920000-0000-7000-8000-0000000000a1')).not.toBe(
      deviceCode('01920000-0000-7000-8000-0000000000b2'),
    );
  });

  test('format and parse round-trip', () => {
    const number = formatTicketNumber(device, 42);
    expect(number).toMatch(/^[0-9A-Z]{3}-0042$/);
    expect(ticketCounter(number)).toBe(42);
    expect(ticketCounter(formatTicketNumber(device, 12345))).toBe(12345);
    expect(ticketCounter('not a number')).toBeNull();
  });
});
