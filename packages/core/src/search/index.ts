// Shared fuzzy search (fuzzy.ts), its in-memory index (fuzzy-index.ts), and the device cache that
// keeps indexes current from projection changes (live-index.ts).
export {
  alignDistance,
  codeScore,
  compactCode,
  compileQuery,
  digitScore,
  foldWord,
  hasExactCode,
  MIN_SCORE,
  normalizeNumber,
  normalizePhone,
  normalizeText,
  prepareDocument,
  SCORE_PART,
  scoreDocument,
  scorePrepared,
  wordSimilarity,
  words,
  type AlignMode,
  type CompiledQuery,
  type PreparedDocument,
  type SearchDocument,
  type Words,
} from './fuzzy.js';
export { FuzzyIndex, type SearchHit } from './fuzzy-index.js';
export {
  searchIndexFor,
  SearchIndexCache,
  type ChangedEntities,
  type SearchScope,
  type SearchSource,
} from './live-index.js';
