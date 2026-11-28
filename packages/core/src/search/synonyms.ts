// Words that mean the same thing at a phone counter. Staff and owners write the same part, fault or
// brand several ways ("batre", "baterai", "battery"; "LCD", "layar"; "matot", "mati total"), and
// customers in Papua describe a fault in their own words ("jato", "pica"), so a query word or phrase
// that belongs to a group also looks for the group's other members. Only the query is expanded:
// documents and indexes stay as they are, so a changed list applies to the next search without a
// rebuild.
//
// A synonym is matched with the same fuzzy comparison as the word itself, just ranked a little lower
// (`SYNONYM_WEIGHT`), so a record that says exactly what was typed comes first. A phrase member
// ("mati total") is compared as its words joined, against a record's joined neighbours.
import {
  foldWord,
  NO_ALTERNATIVES,
  normalizeText,
  type Alternatives,
  type SynonymLookup,
} from './fuzzy.js';
import { SHOP_VOCABULARY } from './shop-vocabulary.js';

/** Groups of words or short phrases, each group meaning one thing. */
export type SynonymGroups = readonly (readonly string[])[];

/** The query word must be this long before a group member it begins counts as typed. */
const PREFIX_MIN = 4;

/** A member as the search compares it: `w` + a folded word, or `p` + a phrase's folded words joined. */
type Member = string;

function member(entry: string): Member | null {
  const words = normalizeText(entry)
    .split(' ')
    .filter((word) => word !== '');
  if (words.length === 0) return null;
  const folded = words.map((word) => foldWord(word));
  return folded.length === 1 ? `w${folded[0]!}` : `p${folded.join('')}`;
}

function split(members: Iterable<Member>, without: Member): Alternatives {
  const words: string[] = [];
  const phrases: string[] = [];
  for (const one of members) {
    if (one === without) continue;
    (one.startsWith('w') ? words : phrases).push(one.slice(1));
  }
  return words.length === 0 && phrases.length === 0 ? NO_ALTERNATIVES : { words, phrases };
}

/** Looks up the other members of a word's or phrase's groups, folded the way the search compares. */
export class Synonyms implements SynonymLookup {
  /** Member → every member of the groups it is in, itself included. */
  readonly #groups = new Map<Member, Set<Member>>();

  constructor(groups: SynonymGroups) {
    for (const group of groups) this.#add(group);
  }

  #add(group: readonly string[]): void {
    const members = group.map(member).filter((one): one is Member => one !== null);
    // Joining groups through a shared member: every member of either reaches the others.
    const joined = new Set<Member>(members);
    for (const one of members) for (const other of this.#groups.get(one) ?? []) joined.add(other);
    for (const one of joined) this.#groups.set(one, joined);
  }

  alternatives(folded: string): Alternatives {
    const key = `w${folded}`;
    const exact = this.#groups.get(key);
    if (exact !== undefined) return split(exact, key);
    // A word still being typed reaches the groups of the one-word members it begins.
    if (folded.length < PREFIX_MIN || /^\d+$/.test(folded)) return NO_ALTERNATIVES;
    const found = new Set<Member>();
    for (const [one, group] of this.#groups) {
      if (one.startsWith(key)) for (const other of group) found.add(other);
    }
    return split(found, key);
  }

  phraseAlternatives(joined: string): Alternatives {
    const key = `p${joined}`;
    const group = this.#groups.get(key);
    return group === undefined ? NO_ALTERNATIVES : split(group, key);
  }

  /** These groups and more, such as an owner's own words on top of the shop's. */
  with(groups: SynonymGroups): Synonyms {
    const merged = new Synonyms([]);
    for (const group of new Set(this.#groups.values())) {
      const copy = new Set(group);
      for (const one of copy) merged.#groups.set(one, copy);
    }
    for (const group of groups) merged.#add(group);
    return merged;
  }
}

export const DEFAULT_SYNONYMS = new Synonyms(SHOP_VOCABULARY);
