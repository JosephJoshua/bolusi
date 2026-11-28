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
  queryWordSimilarity,
  SCORE_PART,
  scoreDocument,
  scorePrepared,
  wordSimilarity,
  words,
  type AlignMode,
  type CompiledQuery,
  type PreparedDocument,
  type SearchDocument,
  type SynonymLookup,
  type Alternatives,
  NO_ALTERNATIVES,
  type Words,
} from './fuzzy.js';
export { FuzzyIndex, type SearchHit } from './fuzzy-index.js';
export { SHOP_VOCABULARY } from './shop-vocabulary.js';
export { DEFAULT_SYNONYMS, Synonyms, type SynonymGroups } from './synonyms.js';
export {
  searchIndexFor,
  SearchIndexCache,
  type ChangedEntities,
  type SearchScope,
  type SearchSource,
} from './live-index.js';
