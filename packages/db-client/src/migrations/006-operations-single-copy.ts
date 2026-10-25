// Client migration 6 — keep one copy of each op: drop `operations.payload` and `operations.location`.
//
// Every op row also stores `signed_core_jcs`, the exact signed text, which contains the payload and
// the location. The two columns were a second, separately sealed copy of the same data: about a
// quarter of the op log, which is most of a device's database. Readers now take both from the signed
// text (projection/oplog-source.ts), the way push already did.
//
// No data is lost: the signed text is the source of truth and holds everything dropped here. The
// `VACUUM` returns the freed pages to the file system and rewrites the file without the old sealed
// copies; like migration 3's, it cannot run inside the migration's transaction.
import type { ClientMigration } from './types.js';

export const operationsSingleCopyMigration: ClientMigration = {
  version: 6,
  name: 'operations_single_copy',
  statements: [
    `ALTER TABLE operations DROP COLUMN payload`,
    `ALTER TABLE operations DROP COLUMN location`,
  ],
  postCommitStatements: ['VACUUM'],
};
