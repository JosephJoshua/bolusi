// The push-time schemaVersion gate (05 §7/§8, 04 §3). A claimed `schemaVersion` is only accepted
// when the system can FOLD it — anything else is rejected at push (SCHEMA_INVALID), never accepted
// and then thrown on at fold time, when the op would already be in the signed, append-only log
// (05 §7 — old ops never disappear).
//
// WHY THE FOLDABLE SET IS EXACTLY `1..current`. The registry declares ONE current version per op
// type (`OperationDeclaration.schemaVersion`, 04 §3), and the applier must fold every historical
// version forever (05 §7; the `notes.note_created` applier folds v1/v2/v3). Versions are monotone
// integers bumped one at a time (define-module.ts: integer ≥ 1; a bump is a new version, never an
// edit), so the versions that have ever existed — and that an applier is therefore obliged to fold —
// are precisely `1..current`. A version `> current` was never declared: no applier, no schema, and
// the applier's `default` branch throws on it. A version `< 1` is not a valid envelope version
// (05 §2.1). Either way there is no registry schema for (`type`, `schemaVersion`), which is a
// SCHEMA_INVALID (05 §8: "Payload fails registry Zod for (`type`, `schemaVersion`)"), not an
// UNKNOWN_TYPE (that is reserved for a `type` absent from the registry — here the type is present).
//
// This is the resolution of the `resolve(type)` signature-vs-impl mismatch (task 121): the registry
// contract is `resolve(type, schemaVersion)` and the schema step already passes the claimed version;
// the version was simply being ignored, so a bogus-version op with an otherwise-current payload was
// accepted at push and blew up at fold. Consulting the registry's current version — never a
// hardcoded number — is what makes a rolling-out old-but-foldable version (e.g. `note_created` v2
// while the server is at v3) still accept, while `99`/`> current` is rejected up front.

/**
 * Is `claimed` a schemaVersion the server can fold for an op type whose CURRENT declared version is
 * `current`? Foldable ⟺ `claimed` is an integer in `1..current` (see file header). `current` is the
 * registry's `schemaVersionFor(type)` / the op declaration's `schemaVersion`; never a literal.
 */
export function isFoldableSchemaVersion(current: number, claimed: number): boolean {
  return Number.isInteger(claimed) && claimed >= 1 && claimed <= current;
}
