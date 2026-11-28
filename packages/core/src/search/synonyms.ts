// Words that mean the same thing at a phone counter. Staff and owners write the same part or brand
// several ways ("batre", "baterai", "battery"; "LCD", "layar"; "ip", "iPhone"), so a query word that
// belongs to a group also looks for the group's other words. Only the query is expanded: documents
// and indexes stay as they are, so a changed list applies to the next search without a rebuild.
//
// A synonym is matched with the same fuzzy comparison as the word itself, just ranked a little
// lower, so a record that says exactly what was typed comes first.
import { foldWord, normalizeText } from './fuzzy.js';

/** Groups of single words, each group meaning one thing. */
export type SynonymGroups = readonly (readonly string[])[];

/**
 * The shop's everyday words. Only true equivalents: "LCD" and "touchscreen" are different parts on
 * many phones, so they are not grouped.
 */
export const SHOP_SYNONYMS: SynonymGroups = [
  ['baterai', 'batre', 'batrai', 'baterei', 'battery', 'batere'],
  ['lcd', 'layar', 'screen', 'display'],
  ['charger', 'cas', 'casan', 'carger', 'charge', 'charging'],
  ['speaker', 'spiker', 'speker', 'loudspeaker'],
  ['mic', 'mik', 'mikrofon', 'microphone', 'mikropon'],
  ['kamera', 'camera'],
  ['tombol', 'button'],
  ['fleksibel', 'flexibel', 'flexible', 'flex', 'fleksi'],
  ['hp', 'handphone', 'hape', 'ponsel'],
  ['iphone', 'ip', 'ipon', 'aifon'],
  ['samsung', 'ss'],
  ['xiaomi', 'xiomi', 'xiaumi'],
  ['earphone', 'headset', 'handsfree', 'hf', 'headphone'],
  ['memori', 'memory', 'mmc'],
  ['antigores', 'tempered', 'tg'],
  ['software', 'sofware', 'softwer'],
  ['kaca', 'glass'],
  ['casing', 'kesing'],
  ['sinyal', 'signal'],
];

/** The query word must be this long before a group member it begins counts as typed. */
const PREFIX_MIN = 4;

/** Looks up the other words of a query word's groups, folded the way the search compares words. */
export class Synonyms {
  /** Folded member → the folded members of its groups. */
  readonly #byWord = new Map<string, Set<string>>();

  constructor(groups: SynonymGroups) {
    for (const group of groups) {
      const keys = group
        .map((word) => normalizeText(word))
        // A multi-word entry cannot stand for one query word.
        .filter((word) => word !== '' && !word.includes(' '))
        .map((word) => foldWord(word));
      for (const key of keys) {
        let set = this.#byWord.get(key);
        if (set === undefined) this.#byWord.set(key, (set = new Set()));
        for (const other of keys) set.add(other);
      }
    }
  }

  /**
   * The folded words to look for besides `folded` itself: its groups' other members, or, for a word
   * still being typed, those of the members it begins.
   */
  alternatives(folded: string): readonly string[] {
    const out = new Set<string>();
    const exact = this.#byWord.get(folded);
    if (exact !== undefined) for (const word of exact) out.add(word);
    else if (folded.length >= PREFIX_MIN && !/^\d+$/.test(folded)) {
      for (const [member, group] of this.#byWord) {
        if (member.startsWith(folded)) for (const word of group) out.add(word);
      }
    }
    out.delete(folded);
    return [...out];
  }

  /** These groups and more, such as an owner's own words on top of the shop's. */
  with(groups: SynonymGroups): Synonyms {
    const merged = new Synonyms([]);
    for (const [word, set] of this.#byWord) merged.#byWord.set(word, new Set(set));
    const extra = new Synonyms(groups);
    for (const [word, set] of extra.#byWord) {
      // Joining two groups through a shared word: every member of either reaches the others.
      const joined = new Set([...(merged.#byWord.get(word) ?? []), ...set]);
      for (const member of joined) {
        merged.#byWord.set(member, new Set([...(merged.#byWord.get(member) ?? []), ...joined]));
      }
    }
    return merged;
  }
}

export const DEFAULT_SYNONYMS = new Synonyms(SHOP_SYNONYMS);
