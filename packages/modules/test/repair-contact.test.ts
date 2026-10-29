import { describe, expect, test } from 'vitest';

import {
  imeiInvalid,
  normalizeImei,
  normalizePhone,
  phoneInvalid,
  sameCustomer,
} from '../src/repair/contact.js';
import { emptyIntakeDraft, stepProblems } from '../src/repair/flows.js';

describe('customer phone numbers', () => {
  test('are stored one way however they were typed', () => {
    for (const typed of [
      '0812-3456-7890',
      '081234567890',
      '812 3456 7890',
      '+62 812 3456 7890',
      '62812-3456-7890',
      '+62 0812 3456 7890',
      '0062 812 3456 7890',
    ]) {
      expect(normalizePhone(typed)).toBe('081234567890');
    }
    expect(normalizePhone('+61 412 345 678')).toBe('+61412345678');
    expect(normalizePhone('(0967) 531 234')).toBe('0967531234');
    expect(normalizePhone('   ')).toBeNull();
  });

  test('that cannot be dialled are caught', () => {
    for (const typed of ['0812345', '081234567', '08123456789012345', '12345678', '+1 555 0100']) {
      expect(phoneInvalid(typed), typed).toBe(true);
    }
    for (const typed of ['', '0812-3456-7890', '0967 531234', '0951 32154', '+61 412 345 678']) {
      expect(phoneInvalid(typed)).toBe(false);
    }
  });

  test('name the same customer only with the same name and number', () => {
    const yohanis = { name: 'Yohanis Wenda', phone: '0812-4455-6677' };
    expect(sameCustomer(yohanis, { name: 'yohanis  wenda ', phone: '+6281244556677' })).toBe(true);
    expect(sameCustomer(yohanis, { name: 'Mama Wenda', phone: '081244556677' })).toBe(false);
    expect(sameCustomer({ ...yohanis, phone: null }, { ...yohanis, phone: null })).toBe(false);
  });
});

describe('IMEI', () => {
  test('is 15 digits whose last is the Luhn check digit', () => {
    expect(imeiInvalid('')).toBe(false);
    expect(imeiInvalid('356789104455660')).toBe(false);
    expect(imeiInvalid('35678910-445566-0')).toBe(false);
    // One digit wrong, two swapped, one short.
    expect(imeiInvalid('356789104455661')).toBe(true);
    expect(imeiInvalid('356789104455606')).toBe(true);
    expect(imeiInvalid('35678910445566')).toBe(true);
    expect(normalizeImei('35678910 4455660')).toBe('356789104455660');
  });
});

describe('intake problems', () => {
  test('point at a wrong phone number and a wrong IMEI', () => {
    const draft = emptyIntakeDraft();
    const options = { photoAngles: [], checks: [], accessories: [], repairTypes: [], readyBy: [] };
    const customer = { kind: 'new' as const, name: 'Yohanis', phone: '0812' };
    expect(stepProblems({ ...draft, customer }, 'customer', options as never)).toEqual([
      'customerPhone',
    ]);
    const device = { ...draft.device, brand: 'Samsung', model: 'A14', imei: '1234' };
    expect(stepProblems({ ...draft, device }, 'device', options as never)).toEqual(['deviceImei']);
  });
});
