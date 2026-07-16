// @bolusi/core module contract (04-module-contract §1/§3/§4): `defineModule` + manifest validation,
// the operation registry (§3), module registration and the 02 §3.2 startup-failure assembly, and
// the factory that wires a build's modules into the command + query runtimes.
//
// This is the contract every module implements. The `notes` reference module (task 25) is its first
// consumer; the fixture module in `@bolusi/test-support` keeps the mechanism itself under test
// (02 §9.3).
export {
  defineModule,
  ModuleDefinitionError,
  type AnyCommandDeclaration,
  type AnyQueryDeclaration,
  type CommandDeclaration,
  // 01 §8.1's conflict declaration (extends 04 §3) — the server's Rule-1 detection reads it, so it
  // must cross the package boundary as a type.
  type ConflictDeclaration,
  type ConflictSeverity,
  type ModuleDefinition,
  type ModuleManifest,
  type ModuleMigration,
  type ModuleProjections,
  type OperationDeclaration,
  // 01 §6's envelope scope (`storeId: null` = tenant-scoped).
  type OperationScope,
  type QueryDeclaration,
} from './define-module.js';

export { checkOpType, type OpTypeRejection } from './op-type.js';

export { isStrictSchema, STRICTNESS_PROBE_KEY } from './strict-schema.js';

export {
  applyModuleMigrations,
  ModuleRegistryError,
  registerModules,
  type AnyModuleDefinition,
  type ModuleRegistry,
  type OperationRegistry,
} from './registry.js';

export { createModuleRuntime, type ModuleRuntime, type ModuleRuntimeOptions } from './runtime.js';
