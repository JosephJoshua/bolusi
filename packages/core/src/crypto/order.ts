// Canonical total order (05-operation-log §4): `timestamp ASC, deviceId ASC, seq ASC`.
//
// Deterministic for any op set regardless of arrival order — FR-1118 hinges on this,
// and every device must fold the same ops into the same sequence. `serverSeq` is
// arrival order and is NEVER an input here (05 §4).

/** The projection of an op this comparator reads. Any envelope satisfies it structurally. */
export interface CanonicalOrderKey {
  /** ms epoch, device clock at the moment the user acted (05 §2.1). */
  timestamp: number;
  /** Originating device — the first tie-break. */
  deviceId: string;
  /** Per-device monotonic counter — the final tie-break. */
  seq: number;
}

/**
 * Compare two ops in canonical order.
 *
 * `deviceId` is compared with `<`/`>` — UTF-16 code-unit order, identical on Hermes
 * and Node. `localeCompare` is deliberately NOT used: it is locale- and ICU-dependent,
 * so it could order the same two ops differently on two devices and silently fork
 * their projections.
 *
 * Returns 0 only for ops with an identical (timestamp, deviceId, seq) triple — which,
 * `seq` being per-device monotonic, means the same op.
 */
export function compareCanonicalOrder(a: CanonicalOrderKey, b: CanonicalOrderKey): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

/**
 * Sort a copy of `ops` into canonical order.
 *
 * Copies rather than sorting in place: callers hold op arrays that belong to the log,
 * and an accidental in-place reorder of the caller's array is the kind of bug this
 * ordering exists to prevent.
 */
export function sortCanonical<T extends CanonicalOrderKey>(ops: readonly T[]): T[] {
  return [...ops].sort(compareCanonicalOrder);
}
