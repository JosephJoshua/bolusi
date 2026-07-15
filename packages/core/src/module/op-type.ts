// Op-type grammar (04-module-contract §3): `<moduleId>.<entity>_<event-past-tense>`.
//
// An op names a FACT that happened (05 §2.1), which is why the grammar insists on past tense —
// contrast a permission, which names a capability and is present tense (02 §2). `notes.note_create`
// is a permission's grammar wearing an op's clothes, and the two registries are far enough apart
// that nothing else would catch the mix-up.
//
// ── WHY THIS IS A HEURISTIC, AND WHY IT IS STILL WORTH HAVING ──────────────────────────────────
//
// "Is this word past tense?" is not decidable from a string. English has irregular pasts identical
// to their present (`reset`), irregulars that differ (`sent`), and particles that trail the verb
// (`locked_out`). So this checker is a RULE, not an oracle, and it is built to fail CLOSED: an
// unrecognized form is a startup failure naming the offending type, and the fix is a reviewed
// addition to `IRREGULAR_PAST_FORMS` — never a silent pass.
//
// The rule was derived from the ACTUAL v0 op-type corpus, not from invented examples (T-12 — test
// the class, not the instances you thought of). Every past-tense type v0 declares, across 04, 02,
// 05, api/02-auth and 01-domain-model:
//
//   notes.note_created · notes.note_body_edited · notes.note_archived
//   auth.user_switched · auth.session_ended · auth.permission_denied · auth.device_enrolled
//   auth.pin_changed · auth.pin_lockout_cleared · auth.pin_locked_out · auth.pin_reset
//   platform.conflict_detected · platform.conflict_acknowledged · platform.user_locale_changed
//
// Two of those break the obvious rule, which is exactly why the corpus was enumerated first:
//   - `auth.pin_locked_out` — the last word is a PARTICLE, not a verb. A naive "last word ends in
//     -ed" rejects a sanctioned runtime emission (04 §5.1).
//   - `auth.pin_reset` — `reset` is an irregular whose past form IS its present form. A naive rule
//     rejects a real v0 op type (02 §4's push-validated privileged PIN ops).
// A checker that rejected either would have been "green" in this file's own tests and fatal at
// task 13/25's startup. Neither was hypothetical; both are in the shipped spec.
//
// ── THE RESIDUAL HOLE, STATED PLAINLY ─────────────────────────────────────────────────────────
//
// `IRREGULAR_PAST_FORMS` contains same-form verbs (`reset`, `set`, `put`, …). For those the string
// is genuinely ambiguous — `pin_reset` (past) and `pin_reset` (present) are the same eleven
// characters, and no checker can separate them. So this rule catches the REGULAR present-tense
// mistake (`note_create`, `user_deactivate`) with certainty and admits the same-form irregulars
// unchecked. That is the honest boundary: it is a typo-catcher for the common case, not a proof of
// tense. Keeping the list short keeps the hole small — every entry added is a word this rule stops
// checking.

/** Anything not lowercase alphanumeric + `_`/`.` is out (04 §3; 02 §2 for the mirror rule). */
const OP_TYPE_SHAPE = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/;

/**
 * Verb particles that may trail a past-tense verb (`locked_out`).
 *
 * Closed and deliberately tiny: each entry lets the checker look one word further left, so a long
 * list would let a present-tense verb hide behind a noun that happens to be spelled like a
 * particle. `out` is the only one v0 needs (`auth.pin_locked_out`); the rest are here because they
 * are the same grammatical construction and adding one later should not require re-deriving this
 * comment.
 */
const VERB_PARTICLES: ReadonlySet<string> = new Set(['out', 'in', 'up', 'down', 'off', 'back']);

/**
 * Irregular past forms — the closed allowlist (see the header for why it is a hole and why it is
 * short). `reset` is the only one v0 declares (`auth.pin_reset`); the others are the irregulars a
 * near-term module is most likely to reach for, added here so the first one does not arrive as a
 * mysterious startup failure. An unlisted irregular fails closed and loud — extend this list in a
 * reviewed commit, and prefer a regular verb.
 */
const IRREGULAR_PAST_FORMS: ReadonlySet<string> = new Set([
  // Same-form irregulars (past === present — inherently ambiguous, see header).
  'reset',
  'set',
  'put',
  'cut',
  'split',
  'shut',
  'read',
  // Distinct-form irregulars (unambiguously past).
  'sent',
  'built',
  'lost',
  'paid',
  'made',
  'held',
  'told',
  'sold',
  'left',
  'kept',
  'met',
  'found',
  'bought',
  'brought',
  'caught',
  'taught',
  'began',
  'began',
  'took',
  'gave',
  'came',
  'went',
  'wrote',
  'broke',
  'chose',
  'froze',
  'spoke',
  'stole',
  'woke',
  'felt',
  'dealt',
  'meant',
  'spent',
  'won',
  'ran',
  'saw',
  'got',
  'did',
  'said',
  'knew',
  'grew',
  'flew',
  'threw',
]);

/** Is one word a past-tense verb form, by the rule in the header? */
function isPastTenseWord(word: string): boolean {
  // A regular past ends in -ed. `-ed` alone is not a word, so require something before it.
  if (word.length > 2 && word.endsWith('ed')) return true;
  return IRREGULAR_PAST_FORMS.has(word);
}

/** Why an op type was rejected — the message names the offending type AND the rule it broke. */
export type OpTypeRejection = string;

/**
 * Validate an op type against 04 §3. Returns `null` when valid, else the reason.
 *
 * `moduleId` is required: the type must be prefixed by the DECLARING module (04 §1 — the module id
 * prefixes op types), which is what keeps types globally unique without a central allocator.
 */
export function checkOpType(type: string, moduleId: string): OpTypeRejection | null {
  if (!OP_TYPE_SHAPE.test(type)) {
    return `op type ${JSON.stringify(type)} is not <moduleId>.<entity>_<event-past-tense> (04 §3) — expected lowercase ${String(OP_TYPE_SHAPE)}`;
  }

  const separator = type.indexOf('.');
  const prefix = type.slice(0, separator);
  const local = type.slice(separator + 1);

  if (prefix !== moduleId) {
    return `op type ${type} is declared by module ${moduleId} but its prefix is ${prefix} — a module may declare op types only under its own id (04 §1/§3)`;
  }

  const words = local.split('_').filter((w) => w.length > 0);
  if (words.length !== local.split('_').length) {
    return `op type ${type} has an empty word (doubled or trailing underscore) — expected <entity>_<event-past-tense> (04 §3)`;
  }
  if (words.length < 2) {
    return `op type ${type} has no <entity>_<event> split — expected <moduleId>.<entity>_<event-past-tense> (04 §3), e.g. ${moduleId}.note_created`;
  }

  // Walk left past any trailing particles (`locked_out`), then test the verb.
  let index = words.length - 1;
  while (index > 0 && VERB_PARTICLES.has(words[index] as string)) index -= 1;

  // Guard: the verb must not BE the entity — `<entity>_<event>` needs both, so a type whose only
  // non-particle word is the first one (e.g. `note_up`) has no event at all.
  if (index < 1) {
    return `op type ${type} is all entity and particles with no past-tense event (04 §3)`;
  }

  if (!isPastTenseWord(words[index] as string)) {
    return `op type ${type} ends in ${JSON.stringify(words[index])}, which is not a past-tense verb — op types name facts that happened and are PAST tense (04 §3: <entity>_<event-past-tense>; contrast permissions, which are present tense, 02 §2). If this is an irregular past form, add it to IRREGULAR_PAST_FORMS in module/op-type.ts.`;
  }

  return null;
}
