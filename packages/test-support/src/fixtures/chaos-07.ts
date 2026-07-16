// CHAOS-07 — concurrent same-entity edits, 2+ devices (testing-guide §3.6; classification per
// 01-domain-model §8). The deterministic op SCRIPTS + the expected-classification TABLE.
//
// Task 26's harness consumes this to drive the full N-device convergence run (sync in a
// PRNG-chosen order, dump every replica, compare oracle digests). Task 17 ships the fixture and
// drives the CLASSIFICATION legs through the real server push pipeline — the conflict rules are
// task 17's, the multi-device convergence is task 26's, and this file is the contract between them.
//
// ── WHY THE EXPECTED TABLE IS DATA AND NOT ASSERTIONS ─────────────────────────────────────────
//
// testing-guide §3.6: "PASS criteria are exhaustive — anything beyond them observed as a diff
// (extra ops on server, extra rows in dumps) is a failure." A harness can only enforce that against
// a CLOSED expectation, so the expected set lives here as data both consumers read, rather than as
// prose each re-interprets. If task 26 and task 17 disagreed about what CHAOS-07 means, the
// disagreement would surface as a harness bug rather than as the spec question it is.
//
// ── DETERMINISM (T-6/T-3) ─────────────────────────────────────────────────────────────────────
//
// Everything derives from `seed`: ids, bodies, timestamps. No clock, no RNG. Bodies are per-seed
// unique (T-3), so a body that survived to the projection names WHICH op won, and a shared-literal
// coincidence cannot make a wrong winner look right.
import { mulberry32 } from '../determinism/prng.js';

/** The three sub-cases (testing-guide §3.6 CHAOS-07). */
export type Chaos07SubCase = 'distinct-timestamps' | 'forced-tie' | 'edit-after-archive';

/** One scripted op, engine-agnostic: the harness signs + chains it per its virtual device. */
export interface Chaos07Op {
  /** `A` | `B` | `C` — which virtual device authors it. */
  readonly device: string;
  readonly type: string;
  readonly entityType: string;
  /** `note-1` | `note-2` — resolved to a real UUID by the consumer. */
  readonly entity: string;
  readonly payload: Record<string, unknown>;
  /** ms epoch. Sub-case (ii) forces a TIE between A and B here (FakeClock, §3.6). */
  readonly timestamp: number;
}

/** One Conflict the sub-case must produce (01 §8.3 / 03 §7). */
export interface Chaos07ExpectedConflict {
  readonly conflictKey: string;
  readonly severity: 'minor' | 'significant';
  /** The RESTING status — `detected` is transient and never observed (01 §5.4). */
  readonly status: 'auto_resolved' | 'surfaced' | 'acknowledged';
  readonly entity: string;
}

export interface Chaos07Case {
  readonly subCase: Chaos07SubCase;
  readonly ops: readonly Chaos07Op[];
  /**
   * The EXHAUSTIVE expected conflict set (§3.6: anything beyond it is a failure).
   *
   * Exhaustive means exhaustive: an empty array would assert "no conflicts at all", not "we did
   * not look". Every case here expects at least one, and the count is the harness's denominator.
   */
  readonly expectedConflicts: readonly Chaos07ExpectedConflict[];
  /**
   * The device whose body must win the `notes.body` projection, under canonical order
   * `(timestamp ASC, deviceId ASC, seq ASC)` (05 §4).
   *
   * `null` where the winner depends on runtime deviceId byte order the fixture cannot know — the
   * forced-tie case. There the harness computes the winner explicitly from the ordering rule and
   * asserts against THAT, which is what §3.6 means by "asserted against the explicitly computed
   * winner" rather than against a value the fixture guessed.
   */
  readonly expectedWinner: string | null;
  /** Total edits across all devices — `edit_count` must equal this (no edit lost, §3.6). */
  readonly expectedEditCount: number;
}

const NOTE_CREATED = 'notes.note_created';
const NOTE_EDITED = 'notes.note_body_edited';
const NOTE_ARCHIVED = 'notes.note_archived';
const CONFLICT_ACK = 'platform.conflict_acknowledged';

/** A per-seed unique body — T-3: never a shared literal. */
function body(seed: number, device: string, n: number): string {
  return `body-${seed}-${device}-${n}`;
}

/**
 * Build CHAOS-07's three sub-cases for a seed (testing-guide §3.6).
 *
 * > *Setup:* Devices A, B, C share one synced note. All go offline; each edits the same note's
 * > body with a distinct seed-derived value. Sub-case (i): distinct timestamps. Sub-case (ii):
 * > **identical `timestamp`** on A and B (tie forced via FakeClock). Sub-case (iii): a second
 * > synced note — device A archives it while device B, offline, edits its body.
 */
export function chaos07Cases(seed: number): readonly Chaos07Case[] {
  const prng = mulberry32(seed);
  // A base far from any other fixture's, jittered per seed so two seeds never share a timestamp.
  const base = 1_726_500_000_000 + Math.floor(prng() * 1_000_000);

  // ── (i) distinct timestamps ─────────────────────────────────────────────────────────────────
  // A, B, C each edit note-1 offline, at strictly increasing times. C is canonically last, so C's
  // body wins the LWW fold and A's + B's survive only in the log (01 §8.3's `minor` row).
  //
  // THREE devices ⇒ THREE unordered pairs (A,B), (A,C), (B,C) — each a Conflict (01 §8.2's dedupe
  // is per unordered pair, so three, not one, and not six).
  const distinct: Chaos07Case = {
    subCase: 'distinct-timestamps',
    ops: [
      {
        device: 'A',
        type: NOTE_CREATED,
        entityType: 'note',
        entity: 'note-1',
        payload: { title: `note-${seed}`, body: body(seed, 'A', 0) },
        timestamp: base,
      },
      {
        device: 'A',
        type: NOTE_EDITED,
        entityType: 'note',
        entity: 'note-1',
        payload: { body: body(seed, 'A', 1) },
        timestamp: base + 1_000,
      },
      {
        device: 'B',
        type: NOTE_EDITED,
        entityType: 'note',
        entity: 'note-1',
        payload: { body: body(seed, 'B', 1) },
        timestamp: base + 2_000,
      },
      {
        device: 'C',
        type: NOTE_EDITED,
        entityType: 'note',
        entity: 'note-1',
        payload: { body: body(seed, 'C', 1) },
        timestamp: base + 3_000,
      },
    ],
    expectedConflicts: [
      { conflictKey: 'note.body', severity: 'minor', status: 'auto_resolved', entity: 'note-1' },
      { conflictKey: 'note.body', severity: 'minor', status: 'auto_resolved', entity: 'note-1' },
      { conflictKey: 'note.body', severity: 'minor', status: 'auto_resolved', entity: 'note-1' },
    ],
    expectedWinner: 'C',
    expectedEditCount: 3,
  };

  // ── (ii) forced timestamp tie ───────────────────────────────────────────────────────────────
  // A and B edit at the IDENTICAL timestamp. Canonical order's first key ties, so the winner is
  // decided by the SECOND key — `deviceId ASC` (05 §4) — deterministically, on every device and
  // the server. §3.6: "in the tie sub-case the op from the greater `deviceId` (byte order) wins".
  //
  // `expectedWinner` is null BY DESIGN: the fixture does not know the harness's runtime deviceIds,
  // and guessing one here would be a fixture asserting a fact it cannot see (T-14b). The harness
  // computes the winner from the ordering rule and asserts against that.
  const tie: Chaos07Case = {
    subCase: 'forced-tie',
    ops: [
      {
        device: 'A',
        type: NOTE_CREATED,
        entityType: 'note',
        entity: 'note-1',
        payload: { title: `note-${seed}`, body: body(seed, 'A', 0) },
        timestamp: base,
      },
      {
        device: 'A',
        type: NOTE_EDITED,
        entityType: 'note',
        entity: 'note-1',
        payload: { body: body(seed, 'A', 1) },
        timestamp: base + 5_000,
      },
      // THE TIE — byte-identical timestamp, different device.
      {
        device: 'B',
        type: NOTE_EDITED,
        entityType: 'note',
        entity: 'note-1',
        payload: { body: body(seed, 'B', 1) },
        timestamp: base + 5_000,
      },
    ],
    expectedConflicts: [
      { conflictKey: 'note.body', severity: 'minor', status: 'auto_resolved', entity: 'note-1' },
    ],
    expectedWinner: null,
    expectedEditCount: 2,
  };

  // ── (iii) edit-after-archive + owner acknowledgment ──────────────────────────────────────────
  // A archives note-2; B, offline through the archive, edits its body. B's edit sorts canonically
  // AFTER the archive ⇒ Rule 2's `notes:edit_after_archive` fires ⇒ significant → surfaced. The
  // owner then acknowledges ⇒ acknowledged.
  //
  // This is the sub-case that exercises BOTH remaining Conflict transitions for D4: `surfaced` and
  // `surfaced → acknowledged`. (i)/(ii) exercise `auto_resolved`. Together: every resting
  // transition in 03 §7.
  //
  // The ack op has NO `timestamp` dependency on the conflict id — the harness substitutes the real
  // conflict id at run time, because it is minted by the server's detection op and cannot be known
  // to a static fixture (01 §5.4: the conflict's id IS the detection op's entityId).
  const archive: Chaos07Case = {
    subCase: 'edit-after-archive',
    ops: [
      {
        device: 'A',
        type: NOTE_CREATED,
        entityType: 'note',
        entity: 'note-2',
        payload: { title: `note2-${seed}`, body: body(seed, 'A', 0) },
        timestamp: base,
      },
      {
        device: 'A',
        type: NOTE_ARCHIVED,
        entityType: 'note',
        entity: 'note-2',
        payload: {},
        timestamp: base + 1_000,
      },
      // B never saw the archive.
      {
        device: 'B',
        type: NOTE_EDITED,
        entityType: 'note',
        entity: 'note-2',
        payload: { body: body(seed, 'B', 1) },
        timestamp: base + 2_000,
      },
      // The owner acknowledges. `entity: 'conflict'` is the placeholder the harness resolves to the
      // surfaced conflict's real id after detection has run.
      {
        device: 'A',
        type: CONFLICT_ACK,
        entityType: 'conflict',
        entity: 'conflict',
        payload: { note: `ack-${seed}` },
        timestamp: base + 9_000,
      },
    ],
    expectedConflicts: [
      {
        conflictKey: 'note.archived',
        severity: 'significant',
        // The resting status AFTER the acknowledgment op syncs (§3.6: "then `surfaced →
        // acknowledged` on every device once the acknowledgment op syncs").
        status: 'acknowledged',
        entity: 'note-2',
      },
    ],
    // The edit stands — 03 §11's total rule: "the body updates, `status` stays `archived`".
    expectedWinner: 'B',
    expectedEditCount: 1,
  };

  return [distinct, tie, archive];
}

/**
 * The classification table, flattened — every Conflict CHAOS-07 must produce, across sub-cases.
 *
 * The T-14 denominator for any sweep: v0's CHAOS-07 produces exactly FIVE conflicts (3 minor pairs
 * in (i), 1 in (ii), 1 significant in (iii)), and both resting transitions are covered. A harness
 * that found four, or six, has found a real change.
 */
export function chaos07ExpectedConflicts(seed: number): readonly Chaos07ExpectedConflict[] {
  return chaos07Cases(seed).flatMap((c) => c.expectedConflicts);
}
