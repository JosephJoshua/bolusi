// `mediaRef` — the shared payload fragment any module embeds when it attaches media
// (06-media-pipeline §3.2). Defined ONCE here and never redefined per module (CLAUDE.md §2.8).
//
// WHY THIS LIVES IN @bolusi/schemas AND NOT @bolusi/core. 06-media-pipeline §3.2 says
// "Defined once in `@bolusi/core` as `mediaRefSchema` (Zod, `.strict()`)". That stated LOCATION
// is impossible and is a known spec defect, not an oversight on our side: 08 §3.3's dependency
// table grants `core` only `schemas` (+ `canonicalize`, `kysely` types) and grants `zod` to
// `schemas` ALONE; `zod` is a devDependency of core; and core/src/module/strict-schema.ts states
// flatly "@bolusi/core may not import zod". Core structurally cannot author a Zod schema. The
// REQUIREMENT of §3.2 — defined once, Zod, `.strict()`, never per-module — is load-bearing and is
// honoured here in full; only the package name moves. The 06 §3.2 text is still wrong and its
// correction is TASK 72 (`ai-docs/tasks/72-mediarefschema-home-contradicts-boundary.md`), filed
// separately because a spec change is never an implementation side effect (CLAUDE.md §4). If you
// are reading §3.2 and this file disagrees with it, §3.2 is the known defect — not this. Nothing enforces the
// core/zod edge today — `bolusi/boundaries` is a deny-list whose header says the §3.3 positive
// allow-matrix is NOT YET IMPLEMENTED (owner: task 28) — so a `zod` import in core would compile,
// lint green, and fail only as a missing runtime dep in core's published `dist`.
import { z } from 'zod';

import { zLocation } from './envelope.js';
import { zMsEpoch, zSha256Hex, zUuid, zUuidV7 } from './primitives.js';

/**
 * v0 media object types (06 §3.2). `video` is deliberately ABSENT, not merely unused: 06 §1
 * defers video to v1 ("v0 ships no video capture UI, no video compression path, and no video
 * tests") and §3.2's own column reads `"image" | "signature"` with `"video"` reserved. "Reserved"
 * means the identifier is spoken for — it does not mean a v0 client accepts one. The parallel
 * `mime` column is explicit about the same split ("v1 adds `video/mp4`"), so admitting `video`
 * here while rejecting `video/mp4` in `zMediaRefMime` would let a ref through that no v0 code
 * path can render.
 *
 * NOTE the deliberate asymmetry with two neighbours that DO carry `video`, because both answer a
 * different question: `10-db §9.4`'s CHECK and `apps/server`'s `zMediaType` describe what the ROW
 * and the WIRE reserve across versions, whereas this describes what a v0 payload may CONTAIN.
 */
export const MEDIA_REF_TYPES = ['image', 'signature'] as const;
export const zMediaRefType = z.enum(MEDIA_REF_TYPES);
export type MediaRefType = z.infer<typeof zMediaRefType>;

/** v0 mime allowlist (06 §3.2; api/03-media §3.1 enforces the same set server-side). */
export const MEDIA_REF_MIMES = ['image/jpeg', 'image/png'] as const;
export const zMediaRefMime = z.enum(MEDIA_REF_MIMES);
export type MediaRefMime = z.infer<typeof zMediaRefMime>;

/**
 * `mediaRef` (06 §3.2) — strict; unknown keys reject.
 *
 * Absent-vs-null (05 §3): `location` is ALWAYS present, explicitly null when there is no fix.
 * `.nullable()` only — `.optional()` must never appear, because a mediaRef rides INSIDE a module
 * payload that is JCS-canonicalized and Ed25519-signed (05 §2–§4), and the hash preimage has no
 * optional keys. An absent key must FAIL parse rather than be defaulted.
 *
 * `location` REUSES `zLocation` from the envelope rather than restating `{lat,lng,accuracyMeters}`
 * — mandatory on two counts. (1) §2.8: one definition. (2) `bolusi/no-float-money` allowlists
 * `z.float64()` to `packages/schemas/src/envelope.ts` AND the property names lat/lng/accuracyMeters
 * (tooling/eslint/src/index.js); retyping them here fires the rule. That the carve-out is
 * file-scoped to the envelope is precisely why the import is the only compliant route: 05 §3's
 * no-floats rule IS scoped to payloads, and mediaRef is a payload fragment — so these floats are
 * admissible here only because they are the envelope's own definition, arriving by reference.
 *
 * `userId`/`deviceId` duplicate the op envelope in v0 (capture and attach happen in one command),
 * but the ref must be self-describing: v1 flows may attach previously-captured media from a
 * different session (06 §3.2).
 *
 * Deliberately NOT enforced here: any mime↔type cross-field rule (e.g. signature ⇒ image/png per
 * 06 §2.3). 06 §3.2's table states the two columns independently, and inventing a constraint the
 * spec does not state would be a spec edit smuggled into an implementation (CLAUDE.md §4). The
 * binding that actually matters is cryptographic and is checked where it belongs: the server
 * magic-byte-sniffs the assembled bytes against the declared mime at `complete` (api/03 §3.4).
 */
export const zMediaRef = z.strictObject({
  /** The `MediaItem.id`. Client-generated at capture (06 §3.2). */
  mediaId: zUuidV7,
  /** Hash of the FINAL file bytes, post-compression (06 §2.2 step 6). */
  sha256: zSha256Hex,
  mime: zMediaRefMime,
  type: zMediaRefType,
  /** Final file size in bytes. Integer — 06 §3.2: "no floats except lat/lng/accuracyMeters". */
  sizeBytes: z.number().int().min(1),
  /** ms epoch, device clock at capture (06 §3.2). */
  capturedAt: zMsEpoch,
  location: zLocation.nullable(),
  userId: zUuid,
  deviceId: zUuid,
});
export type MediaRef = z.infer<typeof zMediaRef>;
