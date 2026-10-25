// The index must return exactly what scoring every document would, for any query, including after
// documents change; and it must stay fast at the size of a busy store's history.
import { describe, expect, test } from 'vitest';

import {
  compileQuery,
  FuzzyIndex,
  scoreDocument,
  type SearchDocument,
} from '../../src/search/index.js';

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  'Yohanis',
  'Maria',
  'Fransiskus',
  'Siti',
  'Achmad',
  'Markus',
  'Yakobus',
  'Hanna',
  'Dorkas',
  'Petrus',
  'Yuliana',
  'Agustinus',
  'Daniel',
  'Elisabeth',
  'Ruth',
  'Djoko',
  'Soekarno',
];
const LAST = [
  'Wenda',
  'Kogoya',
  'Rumbiak',
  'Mandacan',
  'Wonda',
  'Tabuni',
  'Kambu',
  'Sawaki',
  'Iek',
  'Mofu',
  'Kafiar',
  'Rumbewas',
  'Ayomi',
  'Wanggai',
  'Mayor',
];
const BRANDS = ['Samsung', 'Oppo', 'Vivo', 'Xiaomi', 'Realme', 'Infinix'];
const MODELS = ['Galaxy A', 'Reno ', 'Y', 'Redmi Note ', 'C', 'Hot '];

function corpus(size: number, seed: number): SearchDocument[] {
  const next = random(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const digits = (n: number) => Array.from({ length: n }, () => Math.floor(next() * 10)).join('');
  return Array.from({ length: size }, (_, i) => {
    const brand = Math.floor(next() * BRANDS.length);
    return {
      id: `d${i}`,
      text: [
        `${pick(FIRST)} ${pick(LAST)}`,
        BRANDS[brand]!,
        `${MODELS[brand]}${Math.floor(next() * 40)}`,
      ],
      phones: [
        next() < 0.2
          ? null
          : `${pick(['08', '+62 8', '628'])}${pick(['12', '13', '52'])}${digits(8)}`,
      ],
      numbers: [next() < 0.5 ? null : `35${digits(13)}`],
      codes: [`${pick(['K7Q', 'M2X', 'T9B'])}-${String(i).padStart(4, '0')}`],
      rank: Math.floor(next() * 1000),
    };
  });
}

/** A typo: drop, double, swap or replace one character. */
function typo(text: string, next: () => number): string {
  if (text.length < 2) return text;
  const at = Math.floor(next() * (text.length - 1));
  switch (Math.floor(next() * 4)) {
    case 0:
      return text.slice(0, at) + text.slice(at + 1);
    case 1:
      return text.slice(0, at) + text[at] + text.slice(at);
    case 2:
      return text.slice(0, at) + text[at + 1] + text[at] + text.slice(at + 2);
    default:
      return text.slice(0, at) + 'aeiou0123'[Math.floor(next() * 9)] + text.slice(at + 1);
  }
}

function queries(docs: readonly SearchDocument[], count: number, seed: number): string[] {
  const next = random(seed);
  const out = ['a', 'ka', 'yoh', '0812', '12', 'K7Q', 'galaxy a1', 'redmi note', 'x y z q'];
  while (out.length < count) {
    const doc = docs[Math.floor(next() * docs.length)]!;
    const fields = [
      ...doc.text,
      ...(doc.phones ?? []),
      ...(doc.numbers ?? []),
      ...(doc.codes ?? []),
    ].filter((value): value is string => value !== null);
    let query = fields[Math.floor(next() * fields.length)]!;
    // Sometimes only a part, as when someone is still typing or gives the last digits.
    if (next() < 0.4)
      query = next() < 0.5 ? query.slice(0, 3 + Math.floor(next() * 5)) : query.slice(-4);
    if (next() < 0.7) query = typo(query, next);
    out.push(query);
  }
  return out;
}

function scan(docs: readonly SearchDocument[], query: string, limit: number): string[] {
  const compiled = compileQuery(query);
  if (compiled === null) return [];
  return docs
    .map((doc) => ({ doc, score: scoreDocument(compiled, doc) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.doc.rank - a.doc.rank || (a.doc.id < b.doc.id ? -1 : 1))
    .slice(0, limit)
    .map((hit) => hit.doc.id);
}

describe('FuzzyIndex', () => {
  test('returns exactly what a full scan returns, typos and partial input included', () => {
    const docs = corpus(3000, 1);
    const index = new FuzzyIndex(docs);
    let matched = 0;
    for (const query of queries(docs, 300, 2)) {
      const expected = scan(docs, query, 100_000);
      expect(
        index.search(query, 100_000).map((hit) => hit.id),
        query,
      ).toEqual(expected);
      if (expected.length > 0) matched += 1;
    }
    // The comparison means something only if most queries found something.
    expect(matched).toBeGreaterThan(250);
  });

  test('stays identical to a fresh index as documents are replaced and removed', () => {
    const docs = corpus(2000, 3);
    const index = new FuzzyIndex(docs);
    const next = random(4);
    const current = new Map(docs.map((doc) => [doc.id, doc]));
    const replacements = corpus(2000, 5);
    for (let i = 0; i < 1500; i += 1) {
      const id = `d${Math.floor(next() * 2000)}`;
      if (next() < 0.3) {
        index.remove(id);
        current.delete(id);
      } else {
        const doc = { ...replacements[Math.floor(next() * 2000)]!, id };
        index.upsert(doc);
        current.set(id, doc);
      }
    }
    const fresh = [...current.values()];
    expect(index.size).toBe(fresh.length);
    for (const query of queries(fresh, 100, 6)) {
      expect(
        index.search(query, 50).map((hit) => hit.id),
        query,
      ).toEqual(scan(fresh, query, 50));
    }
  });

  test('a removed document is gone even after the slots are compacted', () => {
    const docs = corpus(3000, 7);
    const index = new FuzzyIndex(docs);
    for (let i = 0; i < 2500; i += 1) index.remove(`d${i}`);
    expect(index.size).toBe(500);
    for (const query of queries(docs.slice(2500), 50, 8)) {
      for (const hit of index.search(query, 100))
        expect(Number(hit.id.slice(1))).toBeGreaterThanOrEqual(2500);
    }
  });

  test('50,000 documents: a search takes a few milliseconds, not a scan', () => {
    const docs = corpus(50_000, 9);
    const index = new FuzzyIndex(docs);
    const list = queries(docs, 60, 10);
    for (const query of list.slice(0, 5)) index.search(query, 20);
    const started = performance.now();
    for (const query of list) index.search(query, 20);
    const average = (performance.now() - started) / list.length;
    // About 5 ms on a laptop; the budget leaves room for a slow CI runner, while a regression to
    // scanning every document (about 200 ms here) fails.
    expect(average).toBeLessThan(40);
  });
});
