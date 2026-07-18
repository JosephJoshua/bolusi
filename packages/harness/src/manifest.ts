// The notes projection manifest, extracted from the REAL `@bolusi/modules` module definition — the
// `ModuleProjectionManifest` the digest oracle (§3.4) and the projection engine consume. This is
// the same projection-facing slice `registerModules` derives internally (04 §4); the harness owns
// no second copy of the notes schema (§2.8) — it reads `notesModule.projections.tables` and the
// declared appliers straight off the shipped module.
import type {
  AnyModuleDefinition,
  ModuleProjectionManifest,
  ProjectionApplier,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import { notesModule } from '@bolusi/modules/notes';

/** The projection-facing slice of a module (04 §4) — id, tables, and op-type → applier. */
export function toProjectionManifest<DB>(
  module: AnyModuleDefinition<DB>,
): ModuleProjectionManifest<DB> {
  const appliers: Record<string, ProjectionApplier<DB>> = {};
  for (const [type, declaration] of Object.entries(module.operations)) {
    appliers[type] = declaration.apply;
  }
  return { id: module.id, tables: module.projections.tables, appliers };
}

/** The notes projection manifest over the client schema — the oracle + engine input. */
export const notesProjectionManifest: ModuleProjectionManifest<ClientDatabase> =
  toProjectionManifest(notesModule as unknown as AnyModuleDefinition<ClientDatabase>);
