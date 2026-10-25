// Offline fuzzy search for tickets and customers. Staff type fast and inconsistently, and
// customers misremember their numbers, so nothing a person typed is matched exactly: every query
// word is aligned against every field with an edit distance (insertions, deletions,
// substitutions and swapped neighbours), partial words and words found inside longer ones
// included, and the results are ranked by how close they are. Phone numbers, IMEIs and ticket
// numbers get the same treatment over their digits, so one wrong or swapped digit still finds the
// record. Old and new Indonesian spellings (Soekarno/Sukarno, Djoko/Joko, Johanis/Yohanis) are
// normalized before matching, as a search analyzer would, and never replace the fuzzy match.
//
// Pure functions over rows the caller already holds: customer names and phones are encrypted at
// rest, so the database cannot match them; the query decrypts the store's rows and ranks here.

export interface SearchableCustomer {
  readonly name: string;
  readonly phone: string | null;
}

export interface SearchableTicket extends SearchableCustomer {
  readonly ticketNumber: string;
  readonly deviceBrand: string;
  readonly deviceModel: string;
  readonly deviceImei: string | null;
  readonly createdAt: number;
}

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

type AlignMode = 'whole' | 'prefix' | 'suffix' | 'infix';

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
function alignDistance(pattern: string, text: string, mode: AlignMode, max: number): number {
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
function wordTolerance(length: number): number {
  if (length <= 2) return 0;
  if (length <= 5) return 1;
  if (length <= 9) return 2;
  return 3;
}

/** Edits a digit or code query may carry: last-four lookups stay strict, full numbers forgive. */
function digitTolerance(length: number): number {
  if (length <= 4) return 0;
  if (length <= 8) return 1;
  return 2;
}

/** 1 for no edits, falling towards 0 as the edits approach the query's length. */
function closeness(edits: number, length: number): number {
  return 1 - edits / (length + 1);
}

/** How well one query word matches one target word, in [0, 1]; 0 means no match. */
function wordSimilarity(query: string, target: string): number {
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

/** A query or field split into words, each kept as typed and in its spelling-folded form. */
interface Words {
  readonly plain: readonly string[];
  readonly folded: readonly string[];
}

function words(...texts: readonly (string | null)[]): Words {
  const plain: string[] = [];
  for (const text of texts) {
    if (text === null) continue;
    for (const word of normalizeText(text).split(' ')) if (word !== '') plain.push(word);
  }
  return { plain, folded: plain.map(foldWord) };
}

/** Best similarity of query word `i` against any target word, plain or folded. */
function bestWord(query: Words, i: number, target: Words): number {
  let best = 0;
  for (let j = 0; j < target.plain.length; j += 1) {
    best = Math.max(best, wordSimilarity(query.plain[i]!, target.plain[j]!));
    if (query.folded[i] !== query.plain[i] || target.folded[j] !== target.plain[j]) {
      best = Math.max(best, wordSimilarity(query.folded[i]!, target.folded[j]!));
    }
    if (best === 1) break;
  }
  return best;
}

/**
 * How well all query words match the target words, in [0, 1]. Every word must match for one- and
 * two-word queries; longer queries may miss one word, at a cost.
 */
function wordsScore(query: Words, target: Words): number {
  if (query.plain.length === 0 || target.plain.length === 0) return 0;
  let total = 0;
  let missed = 0;
  for (let i = 0; i < query.plain.length; i += 1) {
    const best = bestWord(query, i, target);
    if (best === 0) missed += 1;
    total += best;
  }
  const allowedMisses = query.plain.length >= 3 ? 1 : 0;
  if (missed > allowedMisses) return 0;
  return total / query.plain.length;
}

/**
 * The whole query with spaces removed against the whole field likewise, for words typed together
 * or apart differently from how they were stored ("galaxya14", "a 14", "rum biak").
 */
function compactScore(query: Words, target: Words): number {
  const q = query.folded.join('');
  const t = target.folded.join('');
  if (q.length < 4 || t.length === 0) return 0;
  const tolerance = wordTolerance(q.length);
  const edits = alignDistance(q, t, 'infix', tolerance);
  return edits <= tolerance ? 0.85 * closeness(edits, q.length) : 0;
}

function textScore(query: Words, target: Words): number {
  return Math.max(wordsScore(query, target), compactScore(query, target));
}

/** A digit string against a stored number, in [0, 1]. Trailing digits ("the last four") rank up. */
function digitScore(query: string, stored: string): number {
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

/** Ticket numbers compacted, with letters read as the digits they are often mistaken for. */
function compactCode(text: string): string {
  return normalizeText(text).replace(/ /g, '').replace(/o/g, '0').replace(/[il]/g, '1');
}

interface CompiledQuery {
  readonly words: Words;
  /** The query as one digit string when it is mostly digits (phone, IMEI, ticket counter). */
  readonly digits: string | null;
  /** The query as a compact code, for ticket numbers like `K7Q-0042`. */
  readonly code: string;
}

function compile(query: string): CompiledQuery | null {
  const normalized = normalizeText(query);
  if (normalized === '') return null;
  const digitCount = query.replace(/\D/g, '').length;
  const letterCount = normalized.replace(/[^a-z]/g, '').length;
  const digits = digitCount >= 3 && letterCount === 0 ? normalizePhone(query) : null;
  return { words: words(query), digits, code: compactCode(query) };
}

function phoneScore(query: CompiledQuery, phone: string | null): number {
  if (query.digits === null || phone === null) return 0;
  return digitScore(query.digits, normalizePhone(phone));
}

function ticketNumberScore(query: CompiledQuery, ticketNumber: string): number {
  if (query.code.length < 3) return 0;
  const code = compactCode(ticketNumber);
  if (code === query.code) return 1;
  const tolerance = digitTolerance(query.code.length);
  let best = 0;
  const whole = alignDistance(query.code, code, 'whole', tolerance);
  if (whole <= tolerance) best = 0.95 * closeness(whole, query.code.length);
  // The counter alone ("0042", "42") is how staff often read a number back.
  const suffix = alignDistance(query.code, code, 'suffix', tolerance);
  if (suffix <= tolerance) best = Math.max(best, 0.8 * closeness(suffix, query.code.length));
  return best;
}

/** Below this a candidate is noise, not a match. */
const MIN_SCORE = 0.4;

export function scoreCustomer(query: string, customer: SearchableCustomer): number {
  const compiled = compile(query);
  return compiled === null ? 0 : customerScore(compiled, customer);
}

function customerScore(compiled: CompiledQuery, customer: SearchableCustomer): number {
  const score = Math.max(
    phoneScore(compiled, customer.phone),
    textScore(compiled.words, words(customer.name)),
  );
  return score >= MIN_SCORE ? score : 0;
}

export function scoreTicket(query: string, ticket: SearchableTicket): number {
  const compiled = compile(query);
  return compiled === null ? 0 : ticketScore(compiled, ticket);
}

function ticketScore(compiled: CompiledQuery, ticket: SearchableTicket): number {
  const imei =
    compiled.digits !== null && ticket.deviceImei !== null
      ? digitScore(compiled.digits, ticket.deviceImei.replace(/\D/g, ''))
      : 0;
  const score = Math.max(
    ticketNumberScore(compiled, ticket.ticketNumber),
    phoneScore(compiled, ticket.phone),
    imei,
    textScore(compiled.words, words(ticket.name, ticket.deviceBrand, ticket.deviceModel)),
  );
  return score >= MIN_SCORE ? score : 0;
}

/** Matching customers, best first. An empty query returns nothing. */
export function searchCustomers<T extends SearchableCustomer>(
  rows: readonly T[],
  query: string,
  limit = 20,
): T[] {
  const compiled = compile(query);
  if (compiled === null) return [];
  return rows
    .map((row) => ({ row, score: customerScore(compiled, row) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
    .slice(0, limit)
    .map((hit) => hit.row);
}

/** Matching tickets, best first, newest first among equals. An empty query returns nothing. */
export function searchTickets<T extends SearchableTicket>(
  rows: readonly T[],
  query: string,
  limit = 20,
): T[] {
  const compiled = compile(query);
  if (compiled === null) return [];
  return rows
    .map((row) => ({ row, score: ticketScore(compiled, row) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.row.createdAt - a.row.createdAt)
    .slice(0, limit)
    .map((hit) => hit.row);
}
