// Synonyms: the shop's different words for one part or brand find each other, ranked below what
// was typed exactly, and an owner's own words join the shop's.
import { describe, expect, test } from 'vitest';

import type { Synonyms } from '../../src/search/index.js';
import { normalizeText } from '../../src/search/fuzzy.js';
import { SHOP_VOCABULARY } from '../../src/search/shop-vocabulary.js';
import {
  compileQuery,
  DEFAULT_SYNONYMS,
  FuzzyIndex,
  scoreDocument,
  type SearchDocument,
} from '../../src/search/index.js';

const item = (id: string, name: string, rank = 0): SearchDocument => ({ id, text: [name], rank });

const items = [
  item('battery', 'Battery Samsung A12'),
  item('baterai', 'Baterai Oppo A5s'),
  item('lcd', 'LCD Xiaomi Redmi 9A'),
  item('cable', 'Kabel data type C'),
  item('ip11', 'Kamera belakang iPhone 11'),
  item('dead', 'Oppo A5s mati total'),
  item('matot', 'Vivo Y12 matot'),
  item('fall', 'HP jatuh, layar pecah'),
];

const ids = (index: FuzzyIndex, text: string, synonyms?: Synonyms): string[] =>
  index.search(text, 10, synonyms).map((hit) => hit.id);

describe('synonyms', () => {
  const index = new FuzzyIndex(items);

  test('a word finds records that use another word of its group', () => {
    expect(ids(index, 'batre')).toEqual(expect.arrayContaining(['battery', 'baterai']));
    expect(ids(index, 'layar redmi')).toEqual(['lcd']);
    expect(ids(index, 'camera ip 11')).toEqual(['ip11']);
    expect(ids(index, 'ss a12')).toEqual(['battery']);
  });

  test('what was typed exactly ranks above a synonym', () => {
    expect(ids(index, 'baterai')).toEqual(['baterai', 'battery']);
    expect(ids(index, 'battery')).toEqual(['battery', 'baterai']);
  });

  test('a word still being typed reaches the synonyms of the word it begins', () => {
    expect(ids(index, 'batt')).toEqual(expect.arrayContaining(['battery', 'baterai']));
  });

  test('a typo in the synonym side still matches', () => {
    expect(ids(index, 'layar xiaomy')).toEqual(['lcd']);
  });

  test('unrelated words are not pulled in', () => {
    expect(ids(index, 'kabel')).toEqual(['cable']);
    expect(DEFAULT_SYNONYMS.alternatives('kabel')).toEqual({ words: [], phrases: [] });
  });

  test('a phrase and its one-word synonym find each other', () => {
    expect(ids(index, 'matot')).toEqual(['matot', 'dead']);
    expect(ids(index, 'mati total')).toEqual(['dead', 'matot']);
  });

  test('a complaint in Papuan Malay finds the record written in standard Indonesian', () => {
    expect(ids(index, 'jato pica')).toEqual(['fall']);
  });

  test('every vocabulary phrase can be found: two words at most', () => {
    for (const group of SHOP_VOCABULARY) {
      for (const entry of group) expect(normalizeText(entry).split(' ').length).toBeLessThan(3);
    }
  });

  test('an owner can add words, joining an existing group', () => {
    const own = DEFAULT_SYNONYMS.with([['aki', 'baterai']]);
    expect(ids(index, 'aki', own)).toEqual(expect.arrayContaining(['battery', 'baterai']));
    // The shop's list is unchanged.
    expect(ids(index, 'aki')).toEqual([]);
  });

  test('the index scores exactly as a full scan does', () => {
    for (const text of [
      'batre',
      'layar redmi',
      'ss a12',
      'batt',
      'camera ip 11',
      'matot',
      'mati total',
      'jato pica',
    ]) {
      const query = compileQuery(text, DEFAULT_SYNONYMS)!;
      const scanned = items
        .map((doc) => ({ id: doc.id, score: scoreDocument(query, doc) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      expect(index.search(text, 10)).toEqual(scanned);
    }
  });
});
