// An in-memory fuzzy index over a set of documents (fuzzy.ts), so a search over tens of thousands
// of records stays interactive on a cheap phone.
//
// Scoring every document on every keystroke is linear in the store's history. Instead the index
// scores text from its vocabulary, shortlists candidates for numbers and codes, and scores only those, with the same scoring a full scan uses (`scorePrepared`).
// The shortlist is a guaranteed superset of the documents that can score above zero, so results
// are identical to scoring everything (test/search/fuzzy-index.test.ts checks that):
//
// - Text: each query word is compared once with every distinct word in the vocabulary (far fewer
//   than the documents), and each document's text score is assembled from those comparisons.
// - Digits and codes: a bigram count filter. A query of m characters within k edits of part of a
//   stored number shares at least (m - 1) - 3k of its bigram positions with it, because one edit
//   (a swap included) breaks at most three bigrams.
//
// Documents are added, replaced and removed one at a time, so callers can keep it current from the
// changes they see rather than rebuilding it.
import {
  allowedMisses,
  compactSimilarity,
  compileQuery,
  digitTolerance,
  hasExactCode,
  MIN_SCORE,
  prepareDocument,
  SCORE_PART,
  scoreNumbers,
  wordSimilarity,
  type CompiledQuery,
  type NumberFields,
  type SearchDocument,
} from './fuzzy.js';

export interface SearchHit {
  readonly id: string;
  readonly score: number;
}

/** A growable list of slots in an Int32Array, a fraction of a JS array's memory. */
class SlotList {
  data = new Int32Array(2);
  length = 0;

  push(slot: number): void {
    if (this.length === this.data.length) {
      const grown = new Int32Array(this.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length] = slot;
    this.length += 1;
  }

  /** Drop the growth slack once a bulk load is done. */
  trim(): void {
    if (this.data.length > this.length) this.data = this.data.slice(0, this.length);
  }
}

type Postings = Map<string, SlotList>;

interface IndexedDocument extends NumberFields {
  readonly doc: SearchDocument;
}

function post(postings: Postings, key: string, slot: number): void {
  let list = postings.get(key);
  if (list === undefined) postings.set(key, (list = new SlotList()));
  list.push(slot);
}

/** Each bigram of `value` with how often it occurs. */
function bigrams(value: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i + 1 < value.length; i += 1) {
    const gram = value.slice(i, i + 2);
    out.set(gram, (out.get(gram) ?? 0) + 1);
  }
  return out;
}

export class FuzzyIndex {
  /**
   * Slot → document and its normalized numbers; null once removed or replaced. Slots are never
   * reused. Words live only in the postings, which keeps the index small on a phone.
   */
  #slots: (IndexedDocument | null)[] = [];
  readonly #slotOf = new Map<string, number>();
  /** Plain and folded words → slots. */
  #words: Postings = new Map();
  /** Folded words and joined neighbours → slots. */
  #compact: Postings = new Map();
  /** `p`/`n`/`c` + bigram of a phone, number or code → slots. */
  #grams: Postings = new Map();

  constructor(documents: Iterable<SearchDocument> = []) {
    for (const doc of documents) this.upsert(doc);
    this.#trim();
  }

  #trim(): void {
    for (const postings of [this.#words, this.#compact, this.#grams]) {
      for (const list of postings.values()) list.trim();
    }
  }

  get size(): number {
    return this.#slotOf.size;
  }

  has(id: string): boolean {
    return this.#slotOf.has(id);
  }

  /** Add the document, or replace the one with the same id. */
  upsert(doc: SearchDocument): void {
    this.remove(doc.id);
    const prepared = prepareDocument(doc);
    const slot = this.#slots.length;
    this.#slots.push({
      doc,
      phones: prepared.phones,
      numbers: prepared.numbers,
      codes: prepared.codes,
    });
    this.#slotOf.set(doc.id, slot);
    for (const term of prepared.words.terms) post(this.#words, term, slot);
    for (const term of new Set(prepared.words.compact)) post(this.#compact, term, slot);
    // A slot is posted once per occurrence, so the filter can count shared bigrams properly.
    const grams = new Map<string, number>();
    const add = (kind: string, value: string) => {
      for (const [gram, count] of bigrams(value)) {
        const key = kind + gram;
        grams.set(key, Math.max(grams.get(key) ?? 0, count));
      }
    };
    for (const phone of prepared.phones) add('p', phone);
    for (const value of prepared.numbers) add('n', value);
    for (const code of prepared.codes) add('c', code);
    for (const [gram, count] of grams)
      for (let i = 0; i < count; i += 1) post(this.#grams, gram, slot);
  }

  remove(id: string): void {
    const slot = this.#slotOf.get(id);
    if (slot === undefined) return;
    this.#slots[slot] = null;
    this.#slotOf.delete(id);
    // Postings keep dead slots until they outnumber the live ones, then everything is re-laid.
    if (this.#slots.length > 1024 && this.#slots.length > 2 * this.#slotOf.size)
      this.#compactSlots();
  }

  #compactSlots(): void {
    const live = this.#slots.filter((slot): slot is IndexedDocument => slot !== null);
    this.#slots = [];
    this.#slotOf.clear();
    this.#words = new Map();
    this.#compact = new Map();
    this.#grams = new Map();
    for (const indexed of live) this.upsert(indexed.doc);
    this.#trim();
  }

  /** The best matches, highest score first, then highest rank, then id. */
  search(input: string, limit: number): SearchHit[] {
    const query = compileQuery(input);
    if (query === null) return [];
    const total = this.#slots.length;
    // Parts still to score per slot; text is scored exactly from the vocabulary instead.
    const candidates = new Uint8Array(total);
    const text = new Float64Array(total);

    this.#scoreText(query, text);
    if (query.digits !== null) {
      this.#gramCandidates('p', SCORE_PART.phones, query.digits, candidates);
    }
    if (query.number !== null) {
      this.#gramCandidates('n', SCORE_PART.numbers, query.number, candidates);
    }
    if (query.code.length >= 3) this.#gramCandidates('c', SCORE_PART.codes, query.code, candidates);

    let hits: { id: string; score: number; rank: number; exact: boolean }[] = [];
    let exactCode = false;
    for (let slot = 0; slot < total; slot += 1) {
      const indexed = this.#slots[slot];
      if (indexed === null || indexed === undefined) continue;
      let score = text[slot]! >= MIN_SCORE ? text[slot]! : 0;
      if (candidates[slot] !== 0) {
        score = Math.max(score, scoreNumbers(query, indexed, candidates[slot]!));
      }
      const exact = hasExactCode(query, indexed);
      if (exact) exactCode = true;
      if (score > 0) hits.push({ id: indexed.doc.id, score, rank: indexed.doc.rank, exact });
    }
    if (exactCode) hits = hits.filter((hit) => hit.exact);
    hits.sort((a, b) => b.score - a.score || b.rank - a.rank || (a.id < b.id ? -1 : 1));
    return hits.slice(0, limit).map(({ id, score }) => ({ id, score }));
  }

  /**
   * Every slot's text score, computed the way `scorePrepared` does but term by term: each query
   * word is compared once per distinct vocabulary term, not once per document.
   */
  #scoreText(query: CompiledQuery, out: Float64Array): void {
    const total = this.#slots.length;
    const wordCount = query.words.plain.length;
    if (wordCount > 0) {
      const sums = new Float64Array(total);
      const misses = new Uint32Array(total);
      const best = new Float64Array(total);
      for (let i = 0; i < wordCount; i += 1) {
        const plain = query.words.plain[i]!;
        const folded = query.words.folded[i]!;
        best.fill(0);
        for (const [term, slots] of this.#words) {
          const similarity = Math.max(
            wordSimilarity(plain, term),
            folded === plain ? 0 : wordSimilarity(folded, term, plain.length),
          );
          if (similarity === 0) continue;
          for (let j = 0; j < slots.length; j += 1) {
            const slot = slots.data[j]!;
            if (similarity > best[slot]!) best[slot] = similarity;
          }
        }
        for (let slot = 0; slot < total; slot += 1) {
          if (best[slot] === 0) misses[slot]! += 1;
          sums[slot]! += best[slot]!;
        }
      }
      const allowed = allowedMisses(wordCount);
      for (let slot = 0; slot < total; slot += 1) {
        if (misses[slot]! <= allowed) out[slot] = sums[slot]! / wordCount;
      }
    }
    if (query.compactTolerance >= 0) {
      for (const [term, slots] of this.#compact) {
        const similarity = compactSimilarity(query, term);
        if (similarity === 0) continue;
        for (let j = 0; j < slots.length; j += 1) {
          const slot = slots.data[j]!;
          if (similarity > out[slot]!) out[slot] = similarity;
        }
      }
    }
  }

  /**
   * Mark slots sharing enough bigrams with `query` (each counted at most as often as it occurs in
   * both) to be within tolerance of some part of a stored value.
   */
  #gramCandidates(
    kind: 'p' | 'n' | 'c',
    part: number,
    query: string,
    candidates: Uint8Array,
  ): void {
    const needed = query.length - 1 - 3 * digitTolerance(query.length);
    const counts = new Uint16Array(this.#slots.length);
    for (const [gram, inQuery] of bigrams(query)) {
      const slots = this.#grams.get(kind + gram);
      if (slots === undefined) continue;
      // A slot's occurrences are adjacent in its posting list; each counts up to the query's own.
      let run = 0;
      for (let i = 0; i < slots.length; i += 1) {
        const slot = slots.data[i]!;
        run = i > 0 && slots.data[i - 1] === slot ? run + 1 : 1;
        if (run <= inQuery) counts[slot]! += 1;
      }
    }
    for (let slot = 0; slot < counts.length; slot += 1) {
      // A filter that cannot prune (needed ≤ 0) must not drop anything: every slot is a candidate.
      if (counts[slot]! >= needed) candidates[slot]! |= part;
    }
  }
}
