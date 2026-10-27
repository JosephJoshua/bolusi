// The notes op rules (core module/op-rules.ts): run by the device before saving and by the server
// before accepting a push. A note is created once and only changed in its own store.
//
// An edit of a note archived meanwhile is NOT refused here: the notes design records it as a
// significant edit-after-archive conflict for the owner (conflict-checks.ts), so the text survives.
import { defineRefusals, type OpRule } from '@bolusi/core';

import type { NotesDatabase } from './schema.js';

type Rule = OpRule<NotesDatabase>;

export const NOTES_REFUSALS = defineRefusals('notes', ['alreadyRecorded', 'noteNotFound'] as const);
const { refuse } = NOTES_REFUSALS;

async function noteInStore(
  db: Parameters<Rule>[1]['db'],
  noteId: string,
  storeId: string | null,
): Promise<boolean> {
  if (storeId === null) return false;
  const row = await db
    .selectFrom('notes')
    .select('id')
    .where('id', '=', noteId)
    .where('storeId', '=', storeId)
    .executeTakeFirst();
  return row !== undefined;
}

export const noteCreatedRule: Rule = async (op, { db }) => {
  const taken = await db
    .selectFrom('notes')
    .select('id')
    .where('id', '=', op.entityId)
    .executeTakeFirst();
  if (taken !== undefined) {
    throw refuse('alreadyRecorded', {
      code: 'VALIDATION_FAILED',
      details: { noteId: op.entityId },
    });
  }
};

/** Edit and archive both need the note, in the op's store. */
export const existingNoteRule: Rule = async (op, { db }) => {
  if (!(await noteInStore(db, op.entityId, op.storeId))) {
    throw refuse('noteNotFound', { code: 'ENTITY_NOT_FOUND', details: { noteId: op.entityId } });
  }
};
