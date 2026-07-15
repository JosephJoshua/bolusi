// @bolusi/core command runtime (04-module-contract §5): the `execute` sequence (§5.1), the `ctx`
// surface handed to handlers (§5.2), and the closed set of sanctioned runtime emissions (§5.1).
//
// This is the single enforcement point for authorization (02-permissions §4) and the only write
// path into the op log (04 §5.1). The `DomainError` code registry (§5.3) lives in ../errors — it
// predates this layer (task 06's state machines throw it) and there is exactly one of it
// (CLAUDE.md §2.8).
//
// The query runtime (04 §6) and `defineModule` (04 §1) are task 11; the sync loop behind
// `SyncSchedulerPort` is task 15.
export {
  CommandRuntime,
  type CommandDefinition,
  type CommandHandlerResult,
  type CommandOutcome,
  type CommandRuntimeOptions,
  type DeviceIdentity,
  type RuntimeEmissionDraft,
} from './execute.js';

// `CTX_RUNTIME_BRAND` is DELIBERATELY NOT re-exported (see ctx.ts). It is the key under which a
// ctx carries the identity and attribution `execute` makes its authorization decision from, and
// keeping it off the package's public surface is a property the code is allowed to rely on — so
// it is asserted by the suite (`ctx-brand.test.ts`), not left to this comment.
export {
  createCommandContext,
  defaultInvocation,
  isOwnContext,
  type BrandedCommandContext,
  type CommandContext,
  type CommandContextBinding,
  type CommandContextInternals,
  type CommandIdentity,
  type InputParser,
  type InvocationMeta,
  type OpDraftInput,
  type QueryExecutorPort,
  type QueryHandle,
} from './ctx.js';

export {
  assertSanctionedEmission,
  isSanctionedRuntimeEmission,
  RuntimeEmissionError,
  SANCTIONED_RUNTIME_EMISSION_TYPES,
  type SanctionedRuntimeEmissionType,
} from './runtime-emissions.js';

export type {
  ClockPort,
  IdSource,
  LocationPort,
  SigningKeyPort,
  SyncSchedulerPort,
} from './ports.js';
