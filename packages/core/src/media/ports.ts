// The media engine's injected seams (08 §3.2; testing-guide T-6/T-7).
//
// @bolusi/core is PLATFORM-FREE (08 §3.3 rule 3): no `fetch`, no `setTimeout`, no `Date.now()`,
// no `expo-*`. The drain loop is made of network, time and FILESYSTEM, so all three arrive here as
// interfaces. That is what lets the whole of 06 §5 run under a FakeClock against an in-memory
// protocol-faithful server with zero sockets and zero files.
//
// These signatures name api/03-media DTOs and nothing else — no Response, no status codes, no
// headers (the same rule sync/ports.ts states: the engine does not know Hono or fetch).

/**
 * A media transport failure, thrown by `MediaTransportPort` adapters.
 *
 * WHY `code` AND NOT `status`, restated for this surface because api/03 §8 makes it sharper than
 * sync's: this surface has THREE `409`s-worth of divergent behaviour and two `422`s that must not
 * be confused. `MEDIA_IMMUTABLE` may mean "you already succeeded, mark it uploaded" while
 * `INIT_MISMATCH` means "never retry this"; `CHUNKS_MISSING` is the NORMAL resume path while
 * `HASH_MISMATCH` may mean the local evidence is destroyed. A drain loop that branched on `422`
 * would conflate a routine resume with unrecoverable corruption. So the loop discriminates on the
 * api/00 §7 envelope's `error.code` and the adapter carries it here verbatim.
 *
 * `code` is `string | null`, not a closed union: api/00 §4 says unknown codes must parse, be
 * treated as non-retryable, and be surfaced rather than dropped — a server that grows a code must
 * not make the client throw on the way to reporting it.
 */
export class MediaTransportError extends Error {
  override readonly name = 'MediaTransportError';
  /** The api/00 §7 error envelope's `error.code`, or `null` for a pre-response failure. */
  readonly code: string | null;
  /** HTTP status when a response was received; `null` for network errors/timeouts. */
  readonly status: number | null;
  /**
   * `details.missingChunks` from a `422 CHUNKS_MISSING` body (api/03 §3.4 step 1). Carried because
   * it is the resume instruction itself; `null` whenever absent.
   */
  readonly missingChunks: readonly number[] | null;

  constructor(
    message: string,
    options?: {
      code?: string | null;
      status?: number | null;
      missingChunks?: readonly number[] | null;
    },
  ) {
    super(message);
    this.code = options?.code ?? null;
    this.status = options?.status ?? null;
    this.missingChunks = options?.missingChunks ?? null;
  }
}

/**
 * The api/03 §8 codes this loop BRANCHES on. Not a validation allowlist — unknown codes are
 * handled (surfaced, non-retryable) rather than rejected, per api/00 §4. Exported so tests assert
 * against the vocabulary instead of re-typing string literals.
 */
export const MEDIA_ERROR_CODES = {
  /** Halt the whole drain — every request will fail the same way (api/03 §8; 05 §8). */
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  AUTH_TOKEN_MISSING: 'AUTH_TOKEN_MISSING',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  /** Upload: re-run `init`. */
  MEDIA_NOT_FOUND: 'MEDIA_NOT_FOUND',
  /** Treat as success iff our sha256 == the server's; else LOCAL_CORRUPT-class. Never overwrite. */
  MEDIA_IMMUTABLE: 'MEDIA_IMMUTABLE',
  /** Bug or tamper — no auto-retry. */
  INIT_MISMATCH: 'INIT_MISMATCH',
  MIME_MISMATCH: 'MIME_MISMATCH',
  /** The normal resume path — upload the listed chunks, retry `complete`. */
  CHUNKS_MISSING: 'CHUNKS_MISSING',
  /** Re-hash locally to decide: retry from 0, or LOCAL_CORRUPT. */
  HASH_MISMATCH: 'HASH_MISMATCH',
  /** Retryable under backoff. */
  RATE_LIMITED: 'RATE_LIMITED',
  STORAGE_ERROR: 'STORAGE_ERROR',
} as const;

/**
 * CLIENT-ORIGINATED, never on the wire (06 §5.1). The server cannot know our file rotted: it
 * reports `HASH_MISMATCH`, and only re-hashing the local bytes distinguishes "the transfer
 * corrupted" (retry from chunk 0) from "the evidence is destroyed" (this code). Kept in the same
 * `lastErrorCode` column as the wire codes because 06 §8 surfaces them through one mapping.
 */
export const LOCAL_CORRUPT_ERROR_CODE = 'LOCAL_CORRUPT';

/** Codes that halt the ENTIRE drain pass, not just the current item (api/03 §8). */
export const DRAIN_HALTING_CODES: ReadonlySet<string> = new Set([
  MEDIA_ERROR_CODES.DEVICE_REVOKED,
  MEDIA_ERROR_CODES.AUTH_TOKEN_MISSING,
  MEDIA_ERROR_CODES.AUTH_TOKEN_INVALID,
]);

/**
 * The codes exempt from retry — EXACTLY FOUR, and the boundary is narrower than it first looks.
 *
 * These are the rows api/03 §8 marks "**no auto-retry**" in so many words (`INIT_MISMATCH`,
 * `MIME_MISMATCH`), plus the two whose owning specs exempt them by name: `LOCAL_CORRUPT` ("stop
 * retrying it — exempt from §5.3 auto-retry", 06 §5.1) and `DEVICE_REVOKED` ("items stop
 * auto-retrying and are flagged individually", 06 §8). It is also exactly the set task 18's
 * acceptance enumerates.
 *
 * WHAT IS DELIBERATELY *NOT* HERE, because the distinction is easy to get backwards (I did):
 * §8's other client-side bugs — `MEDIA_TOO_LARGE`, `CHUNK_TOO_LARGE`, `UNSUPPORTED_ENCODING`,
 * `MIME_UNSUPPORTED`, `VALIDATION_FAILED`, `CHUNK_INDEX_INVALID`, `CHUNK_SIZE_INVALID`. Their
 * column says "Bug; surface" — *surface*, not *stop*. Sweeping them in here looks like prudence
 * and contradicts 03 §4.1's explicit posture: "retries continue at the 5-min cap forever —
 * surfacing escalates visibility, never stops retrying." A retry costs one capped request; being
 * wrong the other way permanently strands evidence over what may be transient version skew. They
 * are surfaced loudly (and trip the persistent-failure flag at 5 attempts) while still retrying.
 *
 * NO TRIGGER REACHES THESE FOUR — including manual. 06 §8 is explicit that for `LOCAL_CORRUPT`
 * and `DEVICE_REVOKED` "the only remedies are re-capture + new op, or re-enrollment": a retry
 * button cannot fix a rotted file or a revoked device, so offering one would be a lie in the UI.
 * The item stays `failed` and visible forever, which is the point (06 §8: silent failure is
 * unacceptable) — `failed` is not terminal in the machine, it is simply unreachable by a trigger.
 *
 * `nextAttemptAt = null` on these is deliberately the SAME value connectivity-regained writes to
 * make an item eligible; null alone reads as "eligible now". What actually holds the exemption is
 * `isAutoRetryable`, applied at BOTH the selection filter and the connectivity reset — never the
 * null alone.
 */
export const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  LOCAL_CORRUPT_ERROR_CODE,
  MEDIA_ERROR_CODES.DEVICE_REVOKED,
  MEDIA_ERROR_CODES.INIT_MISMATCH,
  MEDIA_ERROR_CODES.MIME_MISMATCH,
]);

/** Whether a `failed` item with this `lastErrorCode` may be picked up by an automatic trigger. */
export function isAutoRetryable(lastErrorCode: string | null): boolean {
  if (lastErrorCode === null) return true;
  return !NON_RETRYABLE_CODES.has(lastErrorCode);
}

/** `POST /v1/media/:id/init` body (api/03-media §3.1). */
export interface MediaInitRequest {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mime: string;
  readonly type: string;
  readonly metadata: {
    readonly capturedAt: number;
    readonly location: { lat: number; lng: number; accuracyMeters: number } | null;
    readonly userId: string;
    readonly deviceId: string;
  };
}

/** The server's chunk-session wire states (api/03 §3.3) — NOT `MediaItem.uploadStatus`. */
export type MediaWireStatus = 'receiving' | 'complete';

/** `init` response (api/03 §3.1). `chunkSize` is SERVER-DICTATED — clients never assume one. */
export interface MediaInitResponse {
  readonly chunkSize: number;
  readonly totalChunks: number;
  readonly receivedChunks: readonly number[];
  readonly status: MediaWireStatus;
}

/** `GET /v1/media/:id/status` response (api/03 §3.3) — the ground truth for resume. */
export interface MediaStatusResponse {
  readonly status: MediaWireStatus;
  readonly sizeBytes: number;
  readonly chunkSize: number;
  readonly totalChunks: number;
  readonly receivedChunks: readonly number[];
}

/** `PUT /v1/media/:id/chunks/:index` response (api/03 §3.2). */
export interface MediaChunkResponse {
  readonly receivedChunks: readonly number[];
}

/** `POST /v1/media/:id/complete` response (api/03 §3.4). */
export interface MediaCompleteResponse {
  readonly status: MediaWireStatus;
}

/**
 * The media wire (api/03-media §3), typed by DTOs only.
 *
 * Every method rejects with `MediaTransportError` on any transport/server failure. There is no
 * "partial success" return: api/03's endpoints are each all-or-nothing, so a resolved value always
 * means the server accepted the request.
 */
export interface MediaTransportPort {
  /** Idempotent by media id (api/03 §3.1) — re-init with a byte-identical body is the resume path. */
  init(mediaId: string, request: MediaInitRequest): Promise<MediaInitResponse>;
  /** Raw bytes, `application/octet-stream`, NEVER `Content-Encoding: gzip` (api/03 §3.2, §7). */
  putChunk(mediaId: string, index: number, bytes: Uint8Array): Promise<MediaChunkResponse>;
  status(mediaId: string): Promise<MediaStatusResponse>;
  complete(mediaId: string): Promise<MediaCompleteResponse>;
  /** `GET /v1/media/:id` (api/03 §3.5) — raw bytes; the caller verifies the hash (06 §6). */
  download(mediaId: string): Promise<Uint8Array>;
  /**
   * Does the server's stored hash for `mediaId` equal `sha256`? Resolves `true`/`false`; rejects
   * with `MediaTransportError` if the question cannot be answered (404, network, …).
   *
   * WHY THIS EXISTS — A SPEC GAP, HANDLED RATHER THAN PAPERED OVER. api/03 §8's `MEDIA_IMMUTABLE`
   * row instructs the client to "treat as success if own sha256 matches **server's**", but no
   * endpoint returns the server's sha256: `GET /status` (§3.3) carries `status`/`sizeBytes`/
   * `chunkSize`/`totalChunks`/`receivedChunks` and no hash, and the server renders
   * `MEDIA_IMMUTABLE` with NO `details` (verified in apps/server/src/routes/media.ts:215 — the
   * `complete` check returns before the field-comparison branch, so the code cannot even imply
   * which field differed). The ONLY place the server's hash reaches the wire is the download
   * `ETag: "<sha256>"` (§3.5), which §3.5 also pairs with `If-None-Match ⇒ 304`.
   *
   * So this is that comparison, expressed as the question the loop actually needs, and the adapter
   * implements it with a conditional `GET /v1/media/:id` (`If-None-Match: "<sha256>"`): `304` ⇒
   * true, `200` ⇒ false. Cheap by construction — a match transfers no body — and it invents no
   * wire: every part is §3.5 as written. It is a PORT method rather than an endpoint because
   * api/03 §3 is the endpoint list and this is not a new one.
   *
   * Filed as a spec finding: §8's row should say HOW the comparison is made, because "compare to
   * the server's hash" reads as though an endpoint returns it, and the next implementer will look
   * for one. Fails CLOSED at the call site: a rejection here is treated as "cannot confirm" ⇒
   * LOCAL_CORRUPT-class, never as a match — the one thing that must never happen is marking an
   * item `uploaded` on an unverified assumption.
   */
  matchesServerHash(mediaId: string, sha256: string): Promise<boolean>;
}

/**
 * The filesystem seam (06 §2.2 step 6, §5.1 step 3, §7).
 *
 * `readChunk` is a RANDOM-ACCESS read by contract — "the file is never loaded whole into memory"
 * (06 §5.5). The adapter binds `expo-file-system`'s `File.open()` → `FileHandle` (`offset` +
 * `readBytes`); a naive adapter that read the whole file and sliced would satisfy this interface,
 * violate the spec on a 2 GB device, and pass every test in this repo.
 *
 * NOTHING ENFORCES THAT. This comment previously said the contract was "asserted in the adapter's
 * own suite" — there is no such suite (`apps/mobile/src/media/files.ts` has no tests and no
 * callers; see its header). The contract is stated here and, today, held only by the adapter
 * author reading it. Whoever ships the mobile half (task 18's remaining scope) owes it a test.
 *
 * These methods are `async` because a port must accommodate an async implementation — NOT because
 * the current adapter awaits anything. It does not: `FileHandle.readBytes` returns `Uint8Array`
 * synchronously (File.types.d.ts:82) and quick-crypto's `createHash` is a sync digest. An earlier
 * version of this comment claimed "the READS are async", which was false. What survives the
 * correction is the reason `hashFile` reads in 256 KiB slices at all (06 §2.2 step 6): peak memory
 * stays at one slice instead of the whole file, up to the 10 MiB cap of api/03 §3.1.
 */
export interface MediaFilePort {
  /** Bytes `[offset, offset+length)`. Returns fewer bytes only at EOF. */
  readChunk(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** Lowercase hex SHA-256 over the file's current bytes. */
  hashFile(path: string): Promise<string>;
  /** Size in bytes; rejects if absent. */
  sizeOf(path: string): Promise<number>;
  exists(path: string): Promise<boolean>;
  /** Deletes the file. A missing file is NOT an error — pruning must be idempotent (06 §7). */
  deleteFile(path: string): Promise<void>;
}
