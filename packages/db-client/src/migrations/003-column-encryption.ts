// Client migration 3 — establish at-rest column encryption (D22; security-guide §6.4; 10-db §9).
//
// D22 moved at-rest confidentiality OFF SQLCipher (whole-file) and ONTO application-layer AES-256-GCM
// on the sensitive COLUMNS. That control lives in the connection layer (connection.ts installs the
// decrypt plugin and registers the cipher; the writers seal on write), so there is NO schema change:
// every encrypted column stays `TEXT`, holding base64 ciphertext instead of plaintext — which is why
// the committed codegen types are unchanged by this migration (a value transform, not a schema one).
//
// ── WHAT THIS MIGRATION ACTUALLY DOES, AND THE VACUUM ───────────────────────────────────────────
// On a FRESH v0 device (the only case that exists — no client DB has ever been deployed, per 10-db
// §9 and security-guide §6.6) there is NO pre-existing plaintext to convert: the very first write to
// any of the 11 columns already goes through the cipher. So this migration's `statements` are empty
// and it exists to (a) mark the encryption epoch in the `migrations` ledger and (b) `VACUUM`.
//
// The `VACUUM` is the load-bearing, correct-in-general part. Encrypting a column value IN PLACE (an
// `UPDATE … SET col = <ciphertext>` over an existing plaintext row — the path a hypothetical
// already-populated DB would take) leaves the OLD plaintext bytes in freed SQLite pages until a
// `VACUUM` rewrites the file. That residue is a real at-rest leak (a forensic read of the raw file
// would still find the cleartext), so the migration `VACUUM`s unconditionally. `VACUUM` cannot run
// inside a transaction, so it rides `postCommitStatements` (runner.ts), not `statements`. On the
// empty fresh DB it is a cheap near-no-op; its presence is what makes the migration correct for the
// general conversion case rather than only the fresh one.
// ── WHY THE KEYED MARKER NEEDS NO MIGRATION (asked and answered, not assumed) ──────────────────
// The cipher marker carries a key-derived suffix. Changing the marker format would normally orphan
// every previously-sealed row — they would stop matching and read back as opaque envelope text — so
// it is fair to ask whether a re-seal migration is owed. It is not, and the reason is checkable
// rather than hopeful: **no client database has ever existed.** 001-initial-schema records "no client
// DB is deployed (pre-v0)" twice, and task 148's own investigation established that the Android APK
// has never been assembled by anyone at any point in this repo's life — so no device has ever run the
// codec, and the earlier fixed-marker format exists only in unreleased worktree history. There is
// nothing on disk anywhere to convert.
//
// If that ever stops being true — i.e. once a build ships — a marker-format change becomes a REAL
// data migration: read each sealed cell with the OLD marker, re-seal with the new one, and `VACUUM`
// exactly as this migration does (the old ciphertext is as much a stale freed-page artefact as old
// plaintext would be). Whoever changes `MARKER_LABEL` or the derivation after v0 owes that work.
import type { ClientMigration } from './types.js';

export const columnEncryptionMigration: ClientMigration = {
  version: 3,
  name: 'column_encryption',
  // No DDL: the encrypted columns remain TEXT (base64 ciphertext). The cipher is a connection-layer
  // value transform — see the file header and connection.ts.
  statements: [],
  // Purge any freed pages so an in-place plaintext→ciphertext conversion leaves no stale cleartext
  // (a real leak). Empty/no-op on a fresh v0 DB, but correct for the general case. Outside the tx.
  postCommitStatements: ['VACUUM'],
};
