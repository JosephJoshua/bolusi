// CHAOS-07 — concurrent same-entity edits, 2+ devices (testing-guide §3.6; classification per
// 01-domain-model §8). Drives the THREE §3.6 sub-cases through the REAL server conflict-detection
// pipeline (task 17), never a harness-forked detector (T-7):
//
//   (i)  distinct-timestamps  — A, B, C each edit one synced note offline; Rule-1 (01 §8.2) mints a
//        `{note.body, minor}` Conflict per unordered pair → `detected → auto_resolved`. Winner = the
//        canonically-last edit (highest timestamp). THREE devices ⇒ THREE pairs ⇒ THREE conflicts.
//   (ii) forced-tie           — A and B edit at the IDENTICAL timestamp; the tie resolves on the
//        SECOND canonical key, `deviceId ASC` (05 §4), so the GREATER deviceId (byte order) wins —
//        asserted against the winner canonicalFold actually computes, on every replica and the
//        server. ONE pair ⇒ ONE `{note.body, minor}` conflict.
//   (ii-seq) intra-device tie — two edits from ONE device sharing timestamp AND deviceId, distinct
//        `seq` — so both first keys tie and the winner falls through to the FINAL key, `seq ASC`.
//        Same device ⇒ NOT concurrent ⇒ no Conflict (Rule 1 excludes `P.deviceId = O.deviceId`);
//        this leg asserts only the LWW seq-tiebreak, which §3.6 names explicitly.
//   (iii) edit-after-archive  — A archives a second note (and syncs) while B, offline, edits its
//        body; the Rule-2 check `notes:edit_after_archive` fires at fold → `{note.archived,
//        significant}` → `detected → surfaced`; an owner then acknowledges → `surfaced →
//        acknowledged` on every device. Both remaining Conflict resting transitions (D4) exercised.
//
// The exhaustive expected set is task 17's CONTRACT DATA (`chaos07Cases` / `chaos07ExpectedConflicts`
// in @bolusi/test-support): §3.6 makes the PASS criteria closed, so the count IS the denominator
// (T-14) — four conflicts, or six, is a real change. The winning body is a per-seed-unique value
// (T-3), so a body that survived to the projection NAMES which op won.
//
// FALSIFICATION (§2.11): the positive control at the tail boots the server with detection DISABLED
// (no `systemKeyStore`) and pushes the identical colliding batch — ZERO conflicts appear, proving the
// conflicts in the main tests are the REAL detector's output, not a harness artifact, and that the
// `conflictsDetected` assertion is load-bearing (flip detection off and it goes red).
import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';

import { bytesToBase64, PLATFORM_OP, platformModule, platformModuleManifest } from '@bolusi/core';
import {
  chaos07Cases,
  ChainBuilder,
  deriveDeviceKeypair,
  FakeClock,
  makeIdSource,
  makeWorld,
  mulberry32,
  noblePort,
  type Chaos07Case,
  type ChainWorld,
} from '@bolusi/test-support';
import type { SignedOperation } from '@bolusi/schemas';

import { VirtualDevice, type DeviceIdentity, type ExtraModule } from '../src/device.js';
import { mintIdentities } from '../src/identities.js';
import { assertConvergence, canonicalFold, notesRows } from '../src/oracle.js';
import {
  HarnessServer,
  type HarnessSurfacedConflict,
  type HarnessSystemKeyStore,
} from '../src/server.js';
import { HttpTransport } from '../src/transport.js';
import { resolveSeeds, withSeed } from '../src/index.js';

const GENESIS_CLOCK = 1_726_000_000_000;
const NOTE_CREATED = 'notes.note_created';
const NOTE_EDITED = 'notes.note_body_edited';
const NOTE_ARCHIVED = 'notes.note_archived';

/** Register `platform` on a device so it can fold `platform.conflict_detected` and author the ack. */
const platformExtra = {
  module: platformModule,
  permissionManifest: platformModuleManifest,
} as unknown as ExtraModule;

// ── system identity (the actor for platform.conflict_detected, 01 §3.6) ──────────────────────────

interface SystemIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly publicKeyBase64: string;
  readonly secret: Uint8Array;
}

/** Mint a tenant's system actor + device deterministically (T-6). Index 99 keeps its keypair clear
 *  of the member device indices (0/1/2). */
function mintSystem(tenantSeed: number, tenantId: string): SystemIdentity {
  const ids = makeIdSource(new FakeClock(GENESIS_CLOCK), mulberry32((tenantSeed ^ 0x5157) >>> 0));
  const userId = ids();
  const deviceId = ids();
  const keypair = deriveDeviceKeypair(tenantSeed, 99);
  return {
    tenantId,
    userId,
    deviceId,
    publicKeyBase64: bytesToBase64(keypair.publicKey),
    secret: keypair.seed,
  };
}

// ── one tenant's devices, opened + seeded, keyed by fixture device name (A/B/C) ──────────────────

interface Participant {
  readonly device: VirtualDevice;
  readonly identity: DeviceIdentity;
  readonly auth: string;
}

/**
 * Seed + open a tenant's members and its system device on the server, and register the tenant's
 * system signing key. Returns the participants by fixture name and a teardown.
 */
async function setupTenant(
  server: HarnessServer,
  systemSecrets: Map<string, Uint8Array>,
  tenantSeed: number,
  deviceNames: readonly string[],
): Promise<{ byName: Map<string, Participant>; tenantId: string; close: () => Promise<void> }> {
  const run = mintIdentities(tenantSeed, deviceNames.length);
  const system = mintSystem(tenantSeed, run.tenantId);

  const byName = new Map<string, Participant>();
  for (let i = 0; i < deviceNames.length; i += 1) {
    const identity = run.devices[i]!;
    const seeded = await server.seedDevice(identity);
    const device = await VirtualDevice.open({
      identity,
      clock: new FakeClock(GENESIS_CLOCK),
      prng: mulberry32((tenantSeed + i * 7 + 1) >>> 0),
      extraModules: [platformExtra],
    });
    byName.set(deviceNames[i]!, { device, identity, auth: seeded.auth });
  }

  // The system device is seeded AFTER the members (so the tenant row exists) and its secret keyed to
  // the tenant so `getSystemSigner` can produce a signer that verifies against the seeded pubkey.
  await server.seedSystemDevice({
    tenantId: system.tenantId,
    userId: system.userId,
    deviceId: system.deviceId,
    publicKeyBase64: system.publicKeyBase64,
  });
  systemSecrets.set(system.tenantId, system.secret);

  return {
    byName,
    tenantId: run.tenantId,
    close: async () => {
      for (const p of byName.values()) await p.device.close();
    },
  };
}

// ── authoring: drive the fixture ops through the production command path ─────────────────────────

/** The note ids the fixture's `note-1`/`note-2` placeholders resolve to (A mints them). */
type EntityMap = Map<string, string>;

/** Every non-ack fixture op has an authoring device; find the participant. */
function participant(byName: Map<string, Participant>, name: string): Participant {
  const p = byName.get(name);
  if (p === undefined) throw new Error(`fixture references device ${name} not set up`);
  return p;
}

/**
 * Author the sub-case's creates + edits + archives through the REAL command runtime, setting each
 * device's FakeClock to the scripted `op.timestamp` per op (§3.6 forces the (ii) tie this way). The
 * `platform.conflict_acknowledged` op is NOT authored here — its conflict id is server-minted and
 * resolved after detection runs (the caller drives it).
 *
 * Creates are propagated to every device that will EDIT the same note but did not create it, so the
 * editor holds the note locally (the `editNote`/`archiveNote` command precondition, commands.ts).
 * The archive is deliberately NOT propagated: in (iii) B "never saw the archive", which is the whole
 * point — its edit passes the local precondition and only the server flags it.
 */
async function driveAuthoring(
  byName: Map<string, Participant>,
  caseData: Chaos07Case,
): Promise<EntityMap> {
  const entityToId: EntityMap = new Map();

  // Pass 1 — creates (mint the real note ids).
  for (const op of caseData.ops) {
    if (op.type !== NOTE_CREATED) continue;
    const p = participant(byName, op.device);
    p.device.clock.set(op.timestamp);
    const payload = op.payload as { title: string; body: string };
    const noteId = await p.device.createNote({ title: payload.title, body: payload.body });
    entityToId.set(op.entity, noteId);
  }

  // Propagate each create to the editors of that note (so their command precondition passes).
  for (const op of caseData.ops) {
    if (op.type !== NOTE_CREATED) continue;
    const noteId = entityToId.get(op.entity)!;
    const creator = participant(byName, op.device);
    const createOp = (await creator.device.wireOps()).find(
      (w) => w.type === NOTE_CREATED && w.entityId === noteId,
    )!;
    const editorNames = new Set(
      caseData.ops
        .filter(
          (o) =>
            o.entity === op.entity &&
            o.device !== op.device &&
            o.type !== 'platform.conflict_acknowledged',
        )
        .map((o) => o.device),
    );
    for (const name of editorNames) {
      await participant(byName, name).device.applyForeign(createOp);
    }
  }

  // Pass 2 — edits + archives, in fixture order, each stamped by its device's clock.
  for (const op of caseData.ops) {
    if (op.type === NOTE_CREATED) continue;
    if (op.type === PLATFORM_OP.conflictAcknowledged) continue;
    const p = participant(byName, op.device);
    const noteId = entityToId.get(op.entity)!;
    p.device.clock.set(op.timestamp);
    if (op.type === NOTE_EDITED) {
      await p.device.editNote(noteId, (op.payload as { body: string }).body);
    } else if (op.type === NOTE_ARCHIVED) {
      await p.device.archiveNote(noteId);
    } else {
      throw new Error(`unexpected fixture op type ${op.type}`);
    }
  }

  return entityToId;
}

/** A device's OWN authored ops (genesis + its notes ops), seq-ascending — what it pushes. */
async function ownOps(p: Participant): Promise<SignedOperation[]> {
  return (await p.device.wireOps()).filter((o) => o.deviceId === p.identity.deviceId);
}

/** A device's own NOTES ops only (the oracle's op set; excludes genesis + foreign-fed ops). */
async function ownNotesOps(p: Participant): Promise<SignedOperation[]> {
  return (await ownOps(p)).filter((o) => o.type.startsWith('notes.'));
}

/** Push each named device's own chain to the REAL server, asserting every op is accepted (conflict
 *  detection never rejects — it accepts + flags, 01 §8.2). */
async function pushAll(
  server: HarnessServer,
  byName: Map<string, Participant>,
  order: readonly string[],
): Promise<void> {
  for (const name of order) {
    const p = participant(byName, name);
    const transport = new HttpTransport(server.fetch, p.auth);
    const res = await transport.push({ deviceId: p.identity.deviceId, ops: await ownOps(p) });
    expect(res.results.every((r) => r.status === 'accepted')).toBe(true);
  }
}

// ── server-side + device-side conflict reads ─────────────────────────────────────────────────────

interface ConflictRow {
  readonly conflictKey: string;
  readonly severity: string;
  readonly status: string;
  readonly entityId: string;
  readonly id: string;
}

/** The tenant's conflicts, read as superuser (bypasses RLS) — the real detector output. */
async function serverConflicts(server: HarnessServer, tenantId: string): Promise<ConflictRow[]> {
  const r = await sql<ConflictRow>`
    SELECT id, conflict_key AS "conflictKey", severity, status, entity_id AS "entityId"
    FROM conflicts WHERE tenant_id = ${tenantId} ORDER BY detected_at, id
  `.execute(server.db);
  return r.rows;
}

/** A conflict's status in ONE device's local projection (the "on every device" leg, §3.6). */
async function deviceConflictStatus(device: VirtualDevice, conflictId: string): Promise<string> {
  const r = await sql<{ status: string }>`
    SELECT status FROM conflicts WHERE id = ${conflictId}
  `.execute(device.db);
  return r.rows[0]?.status ?? '(absent)';
}

/** Reconstruct a server-minted op as a wire `SignedOperation`, to feed it into a device's fold. */
async function readServerOp(
  server: HarnessServer,
  tenantId: string,
  type: string,
): Promise<SignedOperation> {
  const r = await sql<{
    id: string;
    tenantId: string;
    storeId: string | null;
    userId: string;
    deviceId: string;
    seq: string;
    type: string;
    entityType: string;
    entityId: string;
    schemaVersion: number;
    payload: unknown;
    timestampMs: string;
    location: unknown;
    source: string;
    agentInitiated: boolean;
    agentConversationId: string | null;
    previousHash: string;
    hash: string;
    signature: string;
  }>`
    SELECT id, tenant_id AS "tenantId", store_id AS "storeId", user_id AS "userId",
           device_id AS "deviceId", seq::text AS seq, type, entity_type AS "entityType",
           entity_id AS "entityId", schema_version AS "schemaVersion", payload,
           timestamp_ms::text AS "timestampMs", location, source,
           agent_initiated AS "agentInitiated", agent_conversation_id AS "agentConversationId",
           previous_hash AS "previousHash", hash, signature
    FROM operations WHERE tenant_id = ${tenantId} AND type = ${type} ORDER BY server_seq LIMIT 1
  `.execute(server.db);
  const row = r.rows[0];
  if (row === undefined) throw new Error(`no server op of type ${type} for tenant ${tenantId}`);
  return {
    id: row.id,
    tenantId: row.tenantId,
    storeId: row.storeId,
    userId: row.userId,
    deviceId: row.deviceId,
    seq: Number(row.seq),
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    schemaVersion: Number(row.schemaVersion),
    payload: row.payload as SignedOperation['payload'],
    timestamp: Number(row.timestampMs),
    location: row.location as SignedOperation['location'],
    source: row.source as SignedOperation['source'],
    agentInitiated: row.agentInitiated,
    agentConversationId: row.agentConversationId,
    previousHash: row.previousHash,
    hash: row.hash,
    signature: row.signature,
  };
}

// ── convergence helpers ──────────────────────────────────────────────────────────────────────────

/** Feed a device every op it does not already hold (idempotent) — the direct-feed convergence path
 *  (CHAOS-01's mechanism), which the engine folds/refolds into canonical order (04 §4.2). */
async function feedMissing(device: VirtualDevice, ops: readonly SignedOperation[]): Promise<void> {
  const held = new Set((await device.wireOps()).map((o) => o.id));
  for (const op of ops) {
    if (held.has(op.id)) continue;
    await device.applyForeign(op);
    held.add(op.id);
  }
}

/** The body of the winning device's LAST edit — the value that must survive LWW (§3.6, T-3). */
function winningEditBody(caseData: Chaos07Case, winnerDevice: string, entity: string): string {
  const edits = caseData.ops.filter(
    (o) => o.device === winnerDevice && o.entity === entity && o.type === NOTE_EDITED,
  );
  const last = edits[edits.length - 1];
  if (last === undefined) throw new Error(`no edit by winner ${winnerDevice} on ${entity}`);
  return (last.payload as { body: string }).body;
}

/** Assert every participant's notes projection converged to the canonical-fold reference. */
async function assertNotesConvergence(
  reference: { digest: string; rows: Awaited<ReturnType<typeof notesRows>> },
  parts: readonly { name: string; device: VirtualDevice }[],
): Promise<void> {
  const replicas = [];
  for (const p of parts) {
    replicas.push({
      name: p.name,
      digest: await p.device.digest(),
      rows: await notesRows(p.device.db),
    });
  }
  assertConvergence(reference, replicas);
}

// ── the three sub-cases ──────────────────────────────────────────────────────────────────────────

/**
 * (i)/(ii): concurrent same-note edits → Rule-1 `{note.body, minor}` conflicts, each `auto_resolved`.
 * The LWW winner is the canonically-last edit; convergence holds on every replica.
 */
async function runConcurrentEdits(
  server: HarnessServer,
  systemSecrets: Map<string, Uint8Array>,
  surfaced: HarnessSurfacedConflict[],
  tenantSeed: number,
  caseData: Chaos07Case,
): Promise<void> {
  const deviceNames = [...new Set(caseData.ops.map((o) => o.device))];
  const { byName, tenantId, close } = await setupTenant(
    server,
    systemSecrets,
    tenantSeed,
    deviceNames,
  );
  try {
    const entityToId = await driveAuthoring(byName, caseData);
    const noteId = entityToId.get('note-1')!;

    // Push in a PRNG-permuted order — Rule 1 is order-independent (whichever pushes later finds the
    // earlier as a candidate), so the conflict SET is invariant under the shuffle (§3.6).
    const order = shuffle(deviceNames, mulberry32((tenantSeed ^ 0xc07) >>> 0));
    await pushAll(server, byName, order);

    // ── the conflicts the REAL detector produced ──
    const conflicts = await serverConflicts(server, tenantId);
    const expected = caseData.expectedConflicts;
    expect(conflicts.length).toBe(expected.length); // the closed denominator (T-14)
    for (const c of conflicts) {
      expect(c.conflictKey).toBe('note.body');
      expect(c.severity).toBe('minor');
      expect(c.status).toBe('auto_resolved'); // minor rests here; never surfaced (03 §7)
      expect(c.entityId).toBe(noteId);
    }
    // minor conflicts surface to nobody — the post-commit hook never fired for this tenant.
    expect(surfaced.filter((s) => s.tenantId === tenantId)).toHaveLength(0);

    // ── LWW convergence: winner = canonically-last edit ──
    const parts = deviceNames.map((n) => ({ name: n, ...byName.get(n)! }));
    const allNotes = (await Promise.all(parts.map((p) => ownNotesOps(p)))).flat();
    const reference = await canonicalFold(allNotes);

    const winnerDevice = caseData.expectedWinner ?? greaterDeviceId(byName, deviceNames);
    const winnerBody = winningEditBody(caseData, winnerDevice, 'note-1');
    const refNote = reference.rows.find((row) => row.id === noteId)!;
    expect(refNote.body).toBe(winnerBody);
    expect(refNote.editCount).toBe(caseData.expectedEditCount);

    for (const p of parts) await feedMissing(p.device, allNotes);
    await assertNotesConvergence(reference, parts);
  } finally {
    await close();
  }
}

/**
 * (iii): edit-after-archive. A archives note-2 (and syncs); B — offline through the archive — edits
 * its body. The Rule-2 check `notes:edit_after_archive` fires at fold → a SIGNIFICANT conflict
 * `{note.archived}` → `surfaced`. An owner then acknowledges → `acknowledged` on every device.
 *
 * PUSH ORDER IS CAUSAL, NOT SHUFFLED: the Rule-2 check runs when the EDIT is accepted and reads the
 * op log for a preceding archive (conflict-detection.ts `existsPrecedingOp`). The scenario is "A
 * archives and syncs, THEN the offline editor reconnects and syncs" — so the archive must be in the
 * log before the edit is pushed, exactly as it is in the field.
 */
async function runEditAfterArchive(
  server: HarnessServer,
  systemSecrets: Map<string, Uint8Array>,
  surfaced: HarnessSurfacedConflict[],
  tenantSeed: number,
  caseData: Chaos07Case,
): Promise<void> {
  const { byName, tenantId, close } = await setupTenant(server, systemSecrets, tenantSeed, [
    'A',
    'B',
  ]);
  try {
    const entityToId = await driveAuthoring(byName, caseData);
    const noteId = entityToId.get('note-2')!;
    const a = byName.get('A')!;
    const b = byName.get('B')!;

    // Archive (A) synced before the edit (B) — the causal order the Rule-2 check needs.
    await pushAll(server, byName, ['A', 'B']);

    // ── the significant conflict, surfaced (not yet acknowledged) ──
    let conflicts = await serverConflicts(server, tenantId);
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0]!;
    expect(conflict.conflictKey).toBe('note.archived');
    expect(conflict.severity).toBe('significant');
    expect(conflict.status).toBe('surfaced');
    expect(conflict.entityId).toBe(noteId);

    // The post-commit hook fired exactly once for a significant conflict (03 §7), category `conflict`.
    const surfacedHere = surfaced.filter((s) => s.tenantId === tenantId);
    expect(surfacedHere).toHaveLength(1);
    expect(surfacedHere[0]!.category).toBe('conflict');
    const conflictId = surfacedHere[0]!.conflictId;
    expect(conflictId).toBe(conflict.id); // the hook id IS the detection op's entityId (01 §5.4)

    // ── acknowledge: round-trip the SERVER-MINTED conflict id ──
    // An owner device appends `platform.conflict_acknowledged` (entityId = the server-minted conflict
    // id) and syncs; the REAL server + client `conflictAcknowledgedApplier` walks the record
    // `surfaced → acknowledged` (03 §7) — the transition §3.6 (iii) asserts.
    //
    // The op is built with the BLESSED `ChainBuilder` (test-support, §3 preamble) over the PRODUCTION
    // `signOp` path — NOT the client `acknowledgeConflict` COMMAND, which is blocked by a real,
    // FILED core bug: `platform.queries.ts`'s `listConflictsQuery` carries no `name`, so the
    // command's `ctx.query(listConflictsQuery)` throws `VALIDATION_FAILED: query has no name` in the
    // real runtime (only its stubbed unit test hid it — notes' `getNoteQuery` self-carries `name` for
    // exactly this reason). See ai-docs/tasks/108-*. The transition under test is the applier's, and
    // it is exercised verbatim here; the command's own coverage is that task's.
    const detectionOp = await readServerOp(server, tenantId, PLATFORM_OP.conflictDetected);
    expect(detectionOp.entityId).toBe(conflictId);

    const ackTimestamp = caseData.ops.find(
      (o) => o.type === PLATFORM_OP.conflictAcknowledged,
    )!.timestamp;
    const ackWorldRaw = makeWorld((tenantSeed ^ 0xac6) >>> 0, noblePort);
    const ackWorld: ChainWorld = { ...ackWorldRaw, tenantId, storeId: a.identity.storeId };
    const ackIdentity: DeviceIdentity = {
      tenantId,
      storeId: a.identity.storeId,
      userId: ackWorld.userId,
      deviceId: ackWorld.deviceId,
      seed: ackWorld.secretKey,
      publicKey: ackWorld.publicKey,
      publicKeyBase64: ackWorld.publicKeyB64,
    };
    const ackSeeded = await server.seedDevice(ackIdentity);
    const ackBuilder = new ChainBuilder(ackWorld, noblePort, GENESIS_CLOCK);
    const genesisOp = ackBuilder.genesis();
    const ackOp = ackBuilder.append({
      type: PLATFORM_OP.conflictAcknowledged,
      entityType: 'conflict',
      entityId: conflictId,
      payload: { note: null },
      timestamp: ackTimestamp,
      source: 'ui',
    });
    const ackTransport = new HttpTransport(server.fetch, ackSeeded.auth);
    const ackRes = await ackTransport.push({
      deviceId: ackWorld.deviceId,
      ops: [genesisOp, ackOp],
    });
    expect(ackRes.results.every((r) => r.status === 'accepted')).toBe(true);

    // The server's conflict walked `surfaced → acknowledged` (03 §7) — the resting status the fixture
    // asserts for this sub-case.
    conflicts = await serverConflicts(server, tenantId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.status).toBe('acknowledged');
    expect(caseData.expectedConflicts[0]!.status).toBe('acknowledged'); // agrees with the contract

    // "on every device once the ack op syncs": every member device folds the detection + ack ops
    // (detection first — the ack applier's `WHERE status='surfaced'` requires the row to exist) and
    // reaches `acknowledged`.
    for (const p of [a, b]) {
      await feedMissing(p.device, [detectionOp, ackOp]);
      expect(await deviceConflictStatus(p.device, conflictId)).toBe('acknowledged');
    }

    // ── notes convergence: the edit stands, note stays archived (03 §11's total rule) ──
    const parts = [
      { name: 'A', ...a },
      { name: 'B', ...b },
    ];
    const allNotes = (await Promise.all(parts.map((p) => ownNotesOps(p)))).flat();
    const reference = await canonicalFold(allNotes);
    const winnerBody = winningEditBody(caseData, caseData.expectedWinner ?? 'B', 'note-2');
    const refNote = reference.rows.find((row) => row.id === noteId)!;
    expect(refNote.body).toBe(winnerBody);
    expect(refNote.editCount).toBe(caseData.expectedEditCount);
    expect(refNote.archived).toBe(1); // archive is terminal; the edit never un-archives it

    for (const p of parts) await feedMissing(p.device, allNotes);
    await assertNotesConvergence(reference, parts);
  } finally {
    await close();
  }
}

/**
 * (ii-seq): the intra-device same-millisecond tie §3.6 names. One device makes two edits sharing
 * timestamp AND deviceId; the winner falls through to the final canonical key, `seq ASC`, so the
 * SECOND edit (greater seq) wins. Same device ⇒ no Conflict (Rule 1 excludes same-device pairs);
 * this asserts only the seq-tiebreak of canonical order, on the device and the fold.
 */
async function runIntraDeviceTie(
  server: HarnessServer,
  systemSecrets: Map<string, Uint8Array>,
  seed: number,
  tenantSeed: number,
): Promise<void> {
  const { byName, tenantId, close } = await setupTenant(server, systemSecrets, tenantSeed, ['A']);
  try {
    const a = byName.get('A')!;
    const ts = 1_726_800_000_000 + (seed % 1000);
    a.device.clock.set(ts - 5_000);
    const noteId = await a.device.createNote({ title: `iiseq-${seed}`, body: `create-${seed}` });
    // Two edits at the SAME timestamp — seq is the only key that differs.
    a.device.clock.set(ts);
    await a.device.editNote(noteId, `first-${seed}`);
    a.device.clock.set(ts);
    await a.device.editNote(noteId, `second-${seed}`);

    // No conflict is possible (same device is not concurrent, 01 §8.2).
    await pushAll(server, byName, ['A']);
    expect(await serverConflicts(server, tenantId)).toHaveLength(0);

    // The greater-seq edit wins on the fold and on the device.
    const allNotes = await ownNotesOps(a);
    const reference = await canonicalFold(allNotes);
    const refNote = reference.rows.find((row) => row.id === noteId)!;
    expect(refNote.body).toBe(`second-${seed}`);
    expect(refNote.editCount).toBe(2);
    const deviceNote = (await notesRows(a.device.db)).find((row) => row.id === noteId)!;
    expect(deviceNote.body).toBe(`second-${seed}`);
    expect(deviceNote.body).toBe(refNote.body);
  } finally {
    await close();
  }
}

// ── deterministic small utilities ────────────────────────────────────────────────────────────────

/** A Fisher–Yates permutation driven by a seeded PRNG (no real RNG, T-6). */
function shuffle<T>(items: readonly T[], prng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(prng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The greater deviceId (UTF-16 code-unit order, 05 §4 / crypto/order.ts) among the named devices —
 *  the winner of a timestamp tie. Two devices only (the forced-tie case). */
function greaterDeviceId(byName: Map<string, Participant>, names: readonly string[]): string {
  let winner = names[0]!;
  for (const name of names) {
    if (byName.get(name)!.identity.deviceId > byName.get(winner)!.identity.deviceId) winner = name;
  }
  return winner;
}

// ── the suite ────────────────────────────────────────────────────────────────────────────────────

describe('CHAOS-07 concurrent same-entity edits', () => {
  for (const seed of resolveSeeds()) {
    test(`CHAOS-07 conflict detection + classification + LWW convergence + acknowledge [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const systemSecrets = new Map<string, Uint8Array>();
          const surfaced: HarnessSurfacedConflict[] = [];
          const keyStore: HarnessSystemKeyStore = {
            getSystemSigner: (tenantId) => {
              const secret = systemSecrets.get(tenantId);
              return secret === undefined ? undefined : (hash) => noblePort.sign(hash, secret);
            },
          };
          const server = await HarnessServer.boot({
            systemKeyStore: keyStore,
            onConflictSurfaced: async (c) => {
              surfaced.push(c);
            },
          });
          try {
            const [distinct, tie, archive] = chaos07Cases(seed) as readonly [
              Chaos07Case,
              Chaos07Case,
              Chaos07Case,
            ];
            // Each sub-case runs on its OWN tenant (isolated conflicts table + system device), so one
            // server boot covers all four legs.
            await runConcurrentEdits(server, systemSecrets, surfaced, seed * 100 + 1, distinct);
            await runConcurrentEdits(server, systemSecrets, surfaced, seed * 100 + 2, tie);
            await runIntraDeviceTie(server, systemSecrets, seed, seed * 100 + 4);
            await runEditAfterArchive(server, systemSecrets, surfaced, seed * 100 + 3, archive);
          } finally {
            await server.close();
          }
        },
        'CHAOS-07',
      );
    });
  }

  // ── WATCHED-RED POSITIVE CONTROL (§2.11) ──────────────────────────────────────────────────────
  // With detection DISABLED (no `systemKeyStore` ⇒ resolveDeps leaves `detectConflicts` undefined),
  // the IDENTICAL colliding push that mints three conflicts in the main test mints ZERO. So the
  // conflicts asserted above are the REAL detector's output (T-7), not a harness artifact, and the
  // `conflicts.length === 3` assertion is load-bearing: turn detection off and it goes red.
  test('CHAOS-07 positive control: detection DISABLED → the identical colliding push produces ZERO conflicts', async () => {
    const seed = 1;
    const server = await HarnessServer.boot(); // no systemKeyStore ⇒ no detection
    try {
      const caseData = chaos07Cases(seed)[0]!; // the distinct-timestamps case (3 conflicts WHEN detecting)
      const deviceNames = [...new Set(caseData.ops.map((o) => o.device))];
      // No system device / key needed — detection never runs.
      const { byName, tenantId, close } = await setupTenant(
        server,
        new Map<string, Uint8Array>(),
        999,
        deviceNames,
      );
      try {
        await driveAuthoring(byName, caseData);
        await pushAll(server, byName, deviceNames);
        // The push SUCCEEDED (ops accepted, asserted in pushAll) but NO conflict was recorded — the
        // detector is what produces them, and it is off.
        expect(await serverConflicts(server, tenantId)).toHaveLength(0);
      } finally {
        await close();
      }
    } finally {
      await server.close();
    }
  });
});
