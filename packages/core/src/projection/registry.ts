// Applier registry (04-module-contract §4.4): manifest → applier / table lookup.
//
// Builds, from one or more registered module manifests, the maps the engine needs per op:
//   op `type`      → owning module + applier (§4.1)
//   (module, entityType) → the tables whose rows the §4.2 re-fold deletes and re-folds
//   module         → its table names / op types (rebuild + invalidation)
// Op types are module-prefixed and globally unique (04 §1); registering the same type or
// module id twice is a programming error and throws.
import type { ModuleProjectionManifest, ProjectionApplier } from './manifest.js';

/** A table the re-fold/invalidation touches for an entity: its name + the id column. */
export interface EntityTableRef {
  readonly table: string;
  readonly entityIdColumn: string;
}

export class ProjectionRegistryError extends Error {
  override readonly name = 'ProjectionRegistryError';
  constructor(message: string) {
    super(message);
  }
}

/** Registry of module projection manifests, keyed for the engine's per-op lookups. */
export class ProjectionRegistry<DB> {
  private readonly modulesById = new Map<string, ModuleProjectionManifest<DB>>();
  private readonly moduleIdByType = new Map<string, string>();

  /** Register a module. Throws on a duplicate module id or a duplicate op type (04 §1). */
  register(module: ModuleProjectionManifest<DB>): void {
    if (this.modulesById.has(module.id)) {
      throw new ProjectionRegistryError(`module already registered: ${module.id}`);
    }
    for (const type of Object.keys(module.appliers)) {
      const existing = this.moduleIdByType.get(type);
      if (existing !== undefined) {
        throw new ProjectionRegistryError(
          `op type ${type} is already owned by module ${existing} (cannot re-register under ${module.id})`,
        );
      }
    }
    this.modulesById.set(module.id, module);
    for (const type of Object.keys(module.appliers)) {
      this.moduleIdByType.set(type, module.id);
    }
  }

  /** The module owning an op type, or `undefined` when no module handles it. */
  moduleForType(type: string): ModuleProjectionManifest<DB> | undefined {
    const id = this.moduleIdByType.get(type);
    return id === undefined ? undefined : this.modulesById.get(id);
  }

  /** The applier for an op type, or `undefined` when unregistered. */
  applierForType(type: string): ProjectionApplier<DB> | undefined {
    const module = this.moduleForType(type);
    return module?.appliers[type];
  }

  /** A registered module by id. */
  module(id: string): ModuleProjectionManifest<DB> | undefined {
    return this.modulesById.get(id);
  }

  /** All registered modules. */
  modules(): readonly ModuleProjectionManifest<DB>[] {
    return [...this.modulesById.values()];
  }

  /**
   * The tables (with id column) whose rows belong to `entityType` in this module — what the
   * §4.2 re-fold deletes and re-folds, and what invalidation fires for. Empty when the module
   * declares no table for that entity type.
   */
  tablesForEntityType(module: ModuleProjectionManifest<DB>, entityType: string): EntityTableRef[] {
    const refs: EntityTableRef[] = [];
    for (const [table, manifest] of Object.entries(module.tables)) {
      if (manifest.entityType === entityType) {
        refs.push({ table, entityIdColumn: manifest.entityIdColumn });
      }
    }
    return refs;
  }

  /** All table names a module declares (rebuild clears these; invalidation fires for these). */
  moduleTableNames(module: ModuleProjectionManifest<DB>): string[] {
    return Object.keys(module.tables);
  }

  /** All op types a module folds (the rebuild scan filters the log to these). */
  moduleOpTypes(module: ModuleProjectionManifest<DB>): string[] {
    return Object.keys(module.appliers);
  }
}
