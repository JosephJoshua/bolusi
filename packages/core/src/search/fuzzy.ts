// Fuzzy matching for everything people type: names, phone numbers, IMEIs, ticket numbers, models,
// item names. Staff type fast and inconsistently and customers misremember their numbers, so
// nothing typed is matched exactly: every query word is aligned against every field with an edit
// distance (insertions, deletions, substitutions and swapped neighbours), partial words and words
// found inside longer ones included, and results are ranked by how close they are. Digits get the
// same treatment, so one wrong or swapped digit still finds the record. Old and new Indonesian
// spellings (Soekarno/Sukarno, Djoko/Joko, Johanis/Yohanis) are normalized first, as a search
// analyzer would, and never replace the fuzzy match.
//
// This file scores one document; fuzzy-index.ts finds the candidates worth scoring.

/** Lowercase, strip accents, keep letters and digits as space-separated words. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Ordered spelling folds, applied to both the query and the target so variants meet in the middle.
const FOLDS: readonly (readonly [RegExp, string])[] = [
  [/oe/g, 'u'], // Soekarno → Sukarno
  [/dj/g, 'j'], // Djoko → Joko
  [/tj/g, 'c'], // Tjahja → Cahja
  [/sj/g, 'sy'], // Sjarif → Syarif
  [/nj/g, 'ny'], // Njoman → Nyoman
  [/ch/g, 'h'], // Achmad → Ahmad
  [/kh/g, 'h'], // Khairul → Hairul
  [/ph/g, 'f'], // Philipus → Filipus
  [/th/g, 't'], // Thomas → Tomas
  [/dh/g, 'd'],
  [/q/g, 'k'],
  [/x/g, 'ks'],
  [/c/g, 'k'], // Jacob → Jakob, Marcus → Markus
  [/v/g, 'f'], // Vera → Fera
  [/j/g, 'y'], // Johanis → Yohanis, Jusuf → Yusuf
  [/y/g, 'i'], // Yanti/Yanty, then j and y meet
  [/([a-z])\1+/g, '$1'], // Hanna → Hana, Yohannes → Yohanes
  [/([aeiou])h$/g, '$1'], // Fatimah → Fatima, Sarah → Sara
];

/** Fold one normalized word to its spelling-insensitive key. Digits are left alone. */
export function foldWord(word: string): string {
  if (/^\d+$/.test(word)) return word;
  const cached = foldCache.get(word);
  if (cached !== undefined) return cached;
  let out = word;
  for (const [pattern, replacement] of FOLDS) out = out.replace(pattern, replacement);
  if (foldCache.size >= 10_000) foldCache.clear();
  foldCache.set(word, out);
  return out;
}

/** Store names and models repeat across tickets, so folding is memoized (bounded). */
const foldCache = new Map<string, string>();

/**
 * Indonesian phone numbers to a single local form: digits only, with a leading country code 62
 * (from 62… or +62…) turned into 0. Returns '' when there are no digits.
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('62')) return `0${digits.slice(2)}`;
  if (digits.startsWith('8') && digits.length >= 9) return `0${digits}`;
  return digits;
}

export type AlignMode = 'whole' | 'prefix' | 'suffix' | 'infix';

// Reused DP rows, grown on demand: search runs over every ticket in the store on each keystroke.
let rows: [Int32Array, Int32Array, Int32Array] = [
  new Int32Array(64),
  new Int32Array(64),
  new Int32Array(64),
];
const charCounts = new Int32Array(65536);

/**
 * A cheap lower bound that rejects most candidates before the DP: every pattern character that
 * does not occur in `text` costs at least one edit wherever the pattern is aligned.
 */
function missingChars(pattern: string, text: string): number {
  for (let j = 0; j < text.length; j += 1) charCounts[text.charCodeAt(j)]! += 1;
  let missing = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const code = pattern.charCodeAt(i);
    if (charCounts[code]! > 0) charCounts[code]! -= 1;
    else missing += 1;
  }
  for (let j = 0; j < text.length; j += 1) charCounts[text.charCodeAt(j)] = 0;
  return missing;
}

/**
 * Optimal-string-alignment edit distance between `pattern` and part of `text`: all of it
 * (`whole`), the best prefix (`prefix`, for a word still being typed), a suffix (`suffix`, for the
 * last digits of a phone) or any substring (`infix`). Returns `max + 1` once it must exceed `max`.
 */
export function alignDistance(pattern: string, text: string, mode: AlignMode, max: number): number {
  const m = pattern.length;
  const n = text.length;
  const freeStart = mode === 'suffix' || mode === 'infix';
  const freeEnd = mode === 'prefix' || mode === 'infix';
  if (mode === 'whole' && Math.abs(m - n) > max) return max + 1;
  if (missingChars(pattern, text) > max) return max + 1;
  if (rows[0].length <= n)
    rows = [new Int32Array(n + 1), new Int32Array(n + 1), new Int32Array(n + 1)];
  let [prev2, prev, cur] = rows;
  for (let j = 0; j <= n; j += 1) prev[j] = freeStart ? 0 : j;
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    let rowMin = i;
    const pc = pattern.charCodeAt(i - 1);
    const pcBefore = i > 1 ? pattern.charCodeAt(i - 2) : -1;
    for (let j = 1; j <= n; j += 1) {
      const tc = text.charCodeAt(j - 1);
      let value = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (pc === tc ? 0 : 1));
      if (j > 1 && pcBefore === tc && pc === text.charCodeAt(j - 2)) {
        value = Math.min(value, prev2[j - 2]! + 1);
      }
      cur[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  if (!freeEnd) return prev[n]!;
  let best = prev[0]!;
  for (let j = 1; j <= n; j += 1) if (prev[j]! < best) best = prev[j]!;
  return best;
}

/** Edits a query word of this length may carry and still match. Short words must be close. */
export function wordTolerance(length: number): number {
  if (length <= 2) return 0;
  if (length <= 5) return 1;
  if (length <= 9) return 2;
  return 3;
}

/** Edits a digit or code query may carry: last-four lookups stay strict, full numbers forgive. */
export function digitTolerance(length: number): number {
  if (length <= 4) return 0;
  if (length <= 8) return 1;
  return 2;
}

/** 1 for no edits, falling towards 0 as the edits approach the query's length. */
function closeness(edits: number, length: number): number {
  return 1 - edits / (length + 1);
}

/** A text field split into words, kept as typed and spelling-folded, plus joined neighbours. */
export interface Words {
  readonly plain: readonly string[];
  readonly folded: readonly string[];
  /** The distinct plain and folded words: what a query word is compared with. */
  readonly terms: readonly string[];
  /**
   * Folded words and each adjacent pair joined, per field, for words typed together or apart
   * differently from how they were stored ("galaxya14", "a 14", "rum biak").
   */
  readonly compact: readonly string[];
}

export function words(texts: readonly (string | null)[]): Words {
  const plain: string[] = [];
  const folded: string[] = [];
  const compact: string[] = [];
  for (const text of texts) {
    if (text === null) continue;
    let previous: string | null = null;
    for (const word of normalizeText(text).split(' ')) {
      if (word === '') continue;
      const key = foldWord(word);
      plain.push(word);
      folded.push(key);
      compact.push(key);
      if (previous !== null) compact.push(previous + key);
      previous = key;
    }
  }
  return { plain, folded, terms: [...new Set([...plain, ...folded])], compact };
}

/** How well one query word matches one target word, in [0, 1]; 0 means no match. */
export function wordSimilarity(query: string, target: string): number {
  if (query === target) return 1;
  const tolerance = wordTolerance(query.length);
  let best = 0;
  const whole = alignDistance(query, target, 'whole', tolerance);
  if (whole <= tolerance) best = 0.95 * closeness(whole, query.length);
  if (query.length < target.length) {
    // A word still being typed: "yoh" for Yohanis, or "yohns" with a typo on the way.
    const prefix = alignDistance(query, target, 'prefix', tolerance);
    if (prefix <= tolerance && (prefix === 0 || query.length >= 3)) {
      const typed = query.length / target.length;
      best = Math.max(best, (0.7 + 0.15 * typed) * closeness(prefix, query.length));
    }
    if (query.length >= 3) {
      // Inside a longer word: "tono" in Sutono. One fewer edit allowed, since it may start anywhere.
      const infixTolerance = Math.max(0, tolerance - 1);
      const infix = alignDistance(query, target, 'infix', infixTolerance);
      if (infix <= infixTolerance) best = Math.max(best, 0.6 * closeness(infix, query.length));
    }
  }
  return best;
}

/** Best similarity of query word `i`, as typed or folded, against any target term. */
function bestWord(query: Words, i: number, target: Words): number {
  const plain = query.plain[i]!;
  const folded = query.folded[i]!;
  let best = 0;
  for (const term of target.terms) {
    best = Math.max(best, wordSimilarity(plain, term));
    if (folded !== plain) best = Math.max(best, wordSimilarity(folded, term));
    if (best === 1) break;
  }
  return best;
}

/** Query words that may go unmatched: none for one or two words, one for longer queries. */
export function allowedMisses(wordCount: number): number {
  return wordCount >= 3 ? 1 : 0;
}

/** How well all query words match the target words, in [0, 1]. */
function wordsScore(query: Words, target: Words): number {
  if (query.plain.length === 0 || target.plain.length === 0) return 0;
  let total = 0;
  let missed = 0;
  for (let i = 0; i < query.plain.length; i += 1) {
    const best = bestWord(query, i, target);
    if (best === 0) missed += 1;
    total += best;
  }
  if (missed > allowedMisses(query.plain.length)) return 0;
  return total / query.plain.length;
}

/** The query with spaces removed, aligned inside one compact term. */
export function compactSimilarity(query: string, term: string): number {
  if (query.length < 4) return 0;
  const tolerance = wordTolerance(query.length);
  const edits = alignDistance(query, term, 'infix', tolerance);
  return edits <= tolerance ? 0.85 * closeness(edits, query.length) : 0;
}

function compactScore(query: CompiledQuery, target: Words): number {
  let best = 0;
  for (const term of target.compact) best = Math.max(best, compactSimilarity(query.compact, term));
  return best;
}

/** A digit string against a stored number, in [0, 1]. Trailing digits ("the last four") rank up. */
export function digitScore(query: string, stored: string): number {
  if (stored === '') return 0;
  if (query === stored) return 1;
  const tolerance = digitTolerance(query.length);
  // An infix alignment is never worse than a suffix or whole one, so a stored number the query is
  // not even inside cannot match at all: most numbers stop after one alignment instead of three.
  const infix = alignDistance(query, stored, 'infix', tolerance);
  if (infix > tolerance) return 0;
  let best = 0.7 * closeness(infix, query.length);
  const suffix = alignDistance(query, stored, 'suffix', tolerance);
  if (suffix > tolerance) return best;
  best = Math.max(best, 0.85 * closeness(suffix, query.length));
  const whole = alignDistance(query, stored, 'whole', tolerance);
  if (whole <= tolerance) best = Math.max(best, 0.95 * closeness(whole, query.length));
  return best;
}

/** Ticket numbers compacted, with letters read as the digits they are often mistaken for. */
export function compactCode(text: string): string {
  return normalizeText(text).replace(/ /g, '').replace(/o/g, '0').replace(/[il]/g, '1');
}

/** A searchable record. Modules build these from their rows; see fuzzy-index.ts. */
export interface SearchDocument {
  readonly id: string;
  /** Free text: names, brands, models, item names. */
  readonly text: readonly (string | null)[];
  /** Phone numbers in any format; matched after normalizing to the local 08… form. */
  readonly phones?: readonly (string | null)[];
  /** Other numbers matched digit by digit, such as IMEIs and serials. */
  readonly numbers?: readonly (string | null)[];
  /** Short codes such as ticket numbers (`K7Q-0042`), with O/0 and I/L/1 treated alike. */
  readonly codes?: readonly (string | null)[];
  /** Tiebreak among equal scores, higher first (usually the creation time). */
  readonly rank: number;
}

/** A query prepared once and scored against many documents. */
export interface CompiledQuery {
  readonly words: Words;
  /** The folded words joined, for `compactSimilarity`. */
  readonly compact: string;
  /** The query as one digit string when it has no letters (phone, IMEI, counter). */
  readonly digits: string | null;
  /** The query as a compact code, for ticket numbers. */
  readonly code: string;
}

export function compileQuery(query: string): CompiledQuery | null {
  const normalized = normalizeText(query);
  if (normalized === '') return null;
  const digitCount = query.replace(/\D/g, '').length;
  const letterCount = normalized.replace(/[^a-z]/g, '').length;
  const parsed = words([query]);
  return {
    words: parsed,
    compact: parsed.folded.join(''),
    digits: digitCount >= 3 && letterCount === 0 ? normalizePhone(query) : null,
    code: compactCode(query),
  };
}

export function normalizeNumber(value: string): string {
  return value.replace(/\D/g, '');
}

/** A code query against a stored code, in [0, 1]. The counter alone ("0042") also matches. */
export function codeScore(query: string, stored: string): number {
  if (query.length < 3 || stored === '') return 0;
  if (query === stored) return 1;
  const tolerance = digitTolerance(query.length);
  // A suffix alignment is never worse than a whole one (see `digitScore`).
  const suffix = alignDistance(query, stored, 'suffix', tolerance);
  if (suffix > tolerance) return 0;
  let best = 0.8 * closeness(suffix, query.length);
  const whole = alignDistance(query, stored, 'whole', tolerance);
  if (whole <= tolerance) best = Math.max(best, 0.95 * closeness(whole, query.length));
  return best;
}

/** Below this a candidate is noise, not a match. */
export const MIN_SCORE = 0.4;

/** A document's numbers and codes, normalized. */
export interface NumberFields {
  readonly phones: readonly string[];
  readonly numbers: readonly string[];
  readonly codes: readonly string[];
}

/** A document with its fields normalized once, for scoring many queries against it. */
export interface PreparedDocument extends NumberFields {
  readonly doc: SearchDocument;
  readonly words: Words;
}

function present(values: readonly (string | null)[] | undefined, normalize: (v: string) => string) {
  const out: string[] = [];
  for (const value of values ?? []) {
    if (value === null) continue;
    const normalized = normalize(value);
    if (normalized !== '') out.push(normalized);
  }
  return out;
}

export function prepareDocument(doc: SearchDocument): PreparedDocument {
  return {
    doc,
    words: words(doc.text),
    phones: present(doc.phones, normalizePhone),
    numbers: present(doc.numbers, normalizeNumber),
    codes: present(doc.codes, compactCode),
  };
}

/** Which parts of a document `scorePrepared` looks at; the index skips parts it ruled out. */
export const SCORE_PART = { text: 1, phones: 2, numbers: 4, codes: 8, all: 15 } as const;

/** The best score among the number and code parts listed in `parts` (see SCORE_PART). */
export function scoreNumbers(query: CompiledQuery, fields: NumberFields, parts: number): number {
  let score = 0;
  if (query.digits !== null) {
    if (parts & SCORE_PART.phones) {
      for (const phone of fields.phones) score = Math.max(score, digitScore(query.digits, phone));
    }
    if (parts & SCORE_PART.numbers) {
      for (const value of fields.numbers) score = Math.max(score, digitScore(query.digits, value));
    }
  }
  if (parts & SCORE_PART.codes) {
    for (const code of fields.codes) score = Math.max(score, codeScore(query.code, code));
  }
  return score >= MIN_SCORE ? score : 0;
}

/** The prepared document's score for the query, in [0, 1]; 0 when it does not match. */
export function scorePrepared(query: CompiledQuery, prepared: PreparedDocument): number {
  const text = Math.max(
    wordsScore(query.words, prepared.words),
    compactScore(query, prepared.words),
  );
  return Math.max(text >= MIN_SCORE ? text : 0, scoreNumbers(query, prepared, SCORE_PART.all));
}

/** The document's score for the query, in [0, 1]; 0 when it does not match. */
export function scoreDocument(query: CompiledQuery, doc: SearchDocument): number {
  return scorePrepared(query, prepareDocument(doc));
}
