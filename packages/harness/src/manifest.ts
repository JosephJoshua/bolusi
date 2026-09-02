// The notes projection manifest for the NODE harness. The generic `toProjectionManifest` extractor
// now lives in the platform-free shared rig (@bolusi/test-support/chaos, task 181); this file binds
// it to the real `@bolusi/modules` notes definition. `notesProjectionManifest` is what the harness's
// `NODE_SEAMS` hands the shared oracle + engine (§2.8 — no second copy of the notes schema).
import type { AnyModuleDefinition, ModuleProjectionManifest } from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import { notesModule } from '@bolusi/modules/notes';
import { toProjectionManifest } from '@bolusi/test-support/chaos';

export { toProjectionManifest } from '@bolusi/test-support/chaos';

/** The notes projection manifest over the client schema — the oracle + engine input. */
export const notesProjectionManifest: ModuleProjectionManifest<ClientDatabase> =
  toProjectionManifest(notesModule as unknown as AnyModuleDefinition<ClientDatabase>);
