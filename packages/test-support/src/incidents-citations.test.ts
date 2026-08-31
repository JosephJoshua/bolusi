// Citation-binding gate (task 189). Task 189 relocated the guard-prose war stories out of the
// hot-path docs (CLAUDE.md §2.11, testing-guide.md T-11…T-19, sec-pending-allowlist.json $comment)
// into ai-docs/incidents.md, leaving one-line normative rules that CITE an incident by an `INC-*`
// token. That citation is only load-bearing if a dangling pointer FAILS THE BUILD — otherwise the
// relocation quietly becomes deletion the first time an anchor is renamed (T-16: a pointer is a
// mention, not a producer; this gate makes the producer — the heading in incidents.md — the thing
// the pointer is checked against). So: every `INC-*` cited from a hot-path doc MUST resolve to a
// heading defined in incidents.md, by EXACT token (INC-T14 and INC-T14F are different anchors).
//
// The gate states its own denominator (T-14): a starved read — an empty incidents.md, a hot-path
// file that stopped citing anything, a glob that matched nothing — must fail loudly, not pass by
// looking at zero tokens. The floors below sit under today's real counts (18 defined, 18 cited) so
// growth never trips them but a collapse does.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { expect, test } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

/** An `INC-*` token: `INC-` then dash-joined uppercase-alnum segments (INC-T14F, INC-SEC-AUTH-10).
 *  Uppercase-only and `\b`-anchored so INC-T14 does NOT swallow the F of INC-T14F — the two are
 *  distinct anchors and the whole point is that a citation of one is not satisfied by the other. */
const INC_TOKEN = /\bINC-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;

/** An incident heading: a Markdown heading (##+) whose first token is an `INC-*` id. This is the
 *  DEFINITION site — the producer a citation must resolve to. */
const INC_HEADING = /^#{2,}\s+(INC-[A-Z0-9]+(?:-[A-Z0-9]+)*)/gm;

/** The hot-path docs that cite incidents. A dangling `INC-*` in any of these fails the build. */
const CITING_SOURCES = [
  'CLAUDE.md',
  'ai-docs/testing-guide.md',
  'packages/test-support/src/sec-pending-allowlist.json',
];

const INCIDENTS_DOC = 'ai-docs/incidents.md';

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

/** Tokens cited from a source, de-duplicated. */
function citedTokens(text: string): Set<string> {
  return new Set(text.match(INC_TOKEN) ?? []);
}

/** Anchors defined by headings in incidents.md, in order (with duplicates, for the collision check). */
function definedAnchors(text: string): string[] {
  const anchors: string[] = [];
  for (const match of text.matchAll(INC_HEADING)) anchors.push(match[1] as string);
  return anchors;
}

test('every INC-* cited from a hot-path doc resolves to a heading defined in incidents.md', () => {
  const incidentsText = read(INCIDENTS_DOC);
  const definedList = definedAnchors(incidentsText);
  const defined = new Set(definedList);

  // Denominator 1 (T-14): incidents.md actually defines anchors. A zero here means the doc was
  // emptied or the heading grammar drifted — every citation would then be "dangling" or, worse,
  // the set would be empty and a naive subset check would pass vacuously.
  expect(defined.size, 'INC-* anchors defined in incidents.md').toBeGreaterThanOrEqual(15);

  // No two headings define the same anchor — a duplicated heading would let a citation resolve to
  // an ambiguous target and mask a copy-paste in the incident log.
  const seen = new Set<string>();
  const duplicates = definedList.filter((a) => (seen.has(a) ? true : (seen.add(a), false)));
  expect(duplicates, 'duplicate INC-* headings in incidents.md').toEqual([]);

  // Collect every cited token across all hot-path sources, remembering which source cited it so a
  // dangling pointer names its file.
  const citations = new Map<string, string[]>(); // token -> sources citing it
  for (const source of CITING_SOURCES) {
    for (const token of citedTokens(read(source))) {
      const sources = citations.get(token);
      if (sources) sources.push(source);
      else citations.set(token, [source]);
    }
  }

  // Denominator 2 (T-14): the hot-path docs really do cite incidents. A zero means the citations
  // were stripped (relocation-became-deletion) and this gate would then have nothing to check.
  expect(citations.size, 'distinct INC-* tokens cited from hot-path docs').toBeGreaterThanOrEqual(
    15,
  );

  // The load-bearing assertion: no dangling pointer. Every cited token must be a DEFINED anchor,
  // by exact-token membership.
  const dangling = [...citations.entries()]
    .filter(([token]) => !defined.has(token))
    .map(([token, sources]) => `${token} (cited in ${sources.join(', ')})`);
  expect(dangling, 'INC-* citations with no matching heading in incidents.md').toEqual([]);
});
