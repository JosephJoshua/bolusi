// The NODE binding of the convergence rig's `ConvergenceSeams` (task 181). The shared rig
// (@bolusi/test-support/chaos) is platform- and domain-free; this file supplies the two things it
// leaves injected for the Node harness: the better-sqlite3 DB engine (`openClientDb`, which binds
// the production `OpAppendStore`) and the real `@bolusi/modules` notes trio. The on-device rig
// (apps/mobile) supplies its own seam over op-sqlite — ONE rig body, two bindings (§2.8).
import type { AnyModuleDefinition } from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import { notesModule, notesModuleManifest } from '@bolusi/modules/notes';
import type { ConvergenceSeams } from '@bolusi/test-support/chaos';

import { openClientDb } from './client-db.js';
import { notesProjectionManifest } from './manifest.js';

export const NODE_SEAMS: ConvergenceSeams = {
  openDb: openClientDb,
  module: notesModule as unknown as AnyModuleDefinition<ClientDatabase>,
  moduleManifest: notesModuleManifest,
  projectionManifest: notesProjectionManifest,
};
