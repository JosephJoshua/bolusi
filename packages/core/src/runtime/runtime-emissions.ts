// The sanctioned runtime-emission channel (04-module-contract §5.1; 02-permissions §4).
//
// COMMANDS ARE THE ONLY WRITE PATH — with exactly FIVE lint-enforced exceptions, where the
// RUNTIME ITSELF appends an op without a command and therefore without a permission check. This
// module is that channel, and the list below is the whole of it. "Nothing else" (04 §5.1) is the
// load-bearing half of the sentence: the set is CLOSED, and adding to it changes 04 §5 first.
//
// WHY EACH OF THE FIVE IS EXEMPT (02 §4) — the exemptions are not a convenience list, and each
// one has a reason that would survive an auditor:
//
//   auth.user_switched / auth.session_ended — authentication PRECEDES authorization (FR-1014).
//     There is no "who" to check a permission against at the moment the who changes.
//   auth.permission_denied — §7: a denial log must not itself be deniable, or the first thing an
//     attacker does is trip the check that stops the logging.
//   auth.device_enrolled — the genesis op (seq 1), appended BEFORE the bundle is written into the
//     directory tables; there is no directory to evaluate against yet (§6 bootstrap rule).
//   auth.pin_locked_out — a lockout record must not depend on the locked-out user's permissions
//     (api/02-auth §6.5).
//
// Each is a case where requiring a permission check would make the record impossible to write at
// exactly the moment it matters most. Nothing else has that property — which is why nothing else
// is on the list.
//
// THE SET IS THE GUARD'S DENOMINATOR (testing-guide T-14). A sixth emission slipping in is the
// exact failure this channel exists to prevent, and a guard that spot-checks "are these five
// allowed?" would never notice a sixth. So the suite asserts the SET — exact membership and exact
// size — not a sample of it, and the channel rejects by allowlist (deny-by-default), never by
// blocklist.

/**
 * The five op types the runtime appends without a command (04 §5.1, 02 §4). CLOSED SET.
 *
 * Exported as an enumerable, ordered constant so callers, tests, and the
 * `bolusi/runtime-emission-allowlist` lint rule all read ONE definition (CLAUDE.md §2.8) — a
 * second, hand-maintained copy of this list is how a sixth type gets in.
 */
export const SANCTIONED_RUNTIME_EMISSION_TYPES = [
  'auth.user_switched',
  'auth.session_ended',
  'auth.permission_denied',
  'auth.pin_locked_out',
  'auth.device_enrolled',
] as const;

/**
 * The five sanctioned types as a union. A non-sanctioned type is a COMPILE-TIME error at every
 * typed call site of the channel; `assertSanctionedEmission` is the runtime backstop for the
 * untyped ones (a JS caller, a value crossing a boundary, a cast).
 */
export type SanctionedRuntimeEmissionType = (typeof SANCTIONED_RUNTIME_EMISSION_TYPES)[number];

/** Membership set — built FROM the constant above, so it cannot disagree with it. */
const SANCTIONED_SET: ReadonlySet<string> = new Set(SANCTIONED_RUNTIME_EMISSION_TYPES);

/** Is `type` one of the five (04 §5.1)? The one membership predicate; nothing re-derives it. */
export function isSanctionedRuntimeEmission(type: string): type is SanctionedRuntimeEmissionType {
  return SANCTIONED_SET.has(type);
}

/**
 * An attempt to append a non-sanctioned op type outside the command layer (04 §5.1).
 *
 * Typed and greppable rather than a `DomainError`: this is not a user-facing domain outcome with
 * a `core.errors.*` row (04 §5.3) — it is a programming error, a caller trying to smuggle a write
 * around the only write path. It has no UI copy because no user should ever see it.
 */
export class RuntimeEmissionError extends Error {
  override readonly name = 'RuntimeEmissionError';
  /** The rejected op type. */
  readonly type: string;

  constructor(type: string) {
    super(
      `${JSON.stringify(type)} is not a sanctioned runtime emission — commands are the only write path (04-module-contract §5.1). Sanctioned: ${SANCTIONED_RUNTIME_EMISSION_TYPES.join(', ')}. Adding to this list changes 04 §5 first.`,
    );
    this.type = type;
  }
}

/**
 * Gate an emission's type against the closed set — deny by default (04 §5.1).
 *
 * Called BEFORE anything is appended, so a rejected type leaves the log untouched: no op row, no
 * projection apply, no chain advance.
 *
 * @throws {RuntimeEmissionError} when `type` is not one of the five.
 */
export function assertSanctionedEmission(
  type: string,
): asserts type is SanctionedRuntimeEmissionType {
  if (!isSanctionedRuntimeEmission(type)) throw new RuntimeEmissionError(type);
}
