// Shared fakes for the media suite, plus their own falsification.
//
// ── WHY THIS FILE IS A `.test.ts` AND NOT A `_fixtures.ts` ──────────────────────────────────────
// `apps/mobile`'s lane colocates tests in `src/` (vitest.config.ts `include`), so a non-`.test`
// helper here would be SHIPPING SOURCE with no production caller — the exact orphan shape task 82
// exists to clean up, recreated by a test helper. Naming it `.test.ts` keeps it inside the lane's
// include glob and out of `knip --production`.
//
// ── THE ORACLE IS INTERROGATED, NOT ASSUMED (T-14/§2.11) ────────────────────────────────────────
// Every fake below is a thing the real assertions depend on, so each carries a test in this file
// proving it BEHAVES. The in-memory filesystem really hashes with node's SHA-256 (so a hash
// assertion is a hash assertion), the shrinking compressor really shrinks (so "compression is real"
// is falsifiable), and the media server really rejects a body whose hash does not match what `init`
// declared (so a green upload means the bytes arrived intact). A fake that said yes to everything
// would make every suite that uses it green for the wrong reason.
import { createHash } from 'node:crypto';

import { MediaTransportError, type MediaFilePort, type TimerPort } from '@bolusi/core';
import { describe, expect, test } from 'vitest';

import type { CompressedImage, ImageCompressorPort, ResizeTarget } from './compression.js';

/**
 * Deterministic bytes that are not all-identical — a run-length fake would hide a slicing bug.
 *
 * Returned as `Uint8Array<ArrayBuffer>`, not the bare `Uint8Array`: TS 5.9 makes typed arrays
 * generic over their buffer, and `fetch`'s `BodyInit` accepts only the `ArrayBuffer` instantiation.
 * `transport.ts` hits the same rule at its chunk PUT and copies for the same reason.
 */
export function bytesOfLength(length: number, seed = 7): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) out[index] = (index * seed + 13) & 0xff;
  return out;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * An in-memory `MediaFilePort` + the two directory seams, with the REAL failure modes files.ts has:
 * `hashFile` and `sizeOf` REJECT on a missing file rather than returning the empty-string digest or
 * 0 (T-19, the two bugs review-18 found). A fake that resolved them would make the capture pipeline
 * look correct precisely where it is most dangerous.
 */
export class FakeFs {
  readonly files = new Map<string, Uint8Array>();
  /** Every `move` performed, in order — the capture-ordering assertions read this. */
  readonly moves: { from: string; to: string }[] = [];

  write(path: string, bytes: Uint8Array): string {
    this.files.set(path, bytes);
    return path;
  }

  read(path: string): Uint8Array {
    const found = this.files.get(path);
    if (found === undefined) throw new Error(`no such file ${path}`);
    return found;
  }

  // `async`, not `() => Promise.resolve(...)`: the real adapter is an async method, so a missing
  // file arrives as a REJECTION rather than a synchronous throw. A fake that threw synchronously
  // would let a caller's `try` catch something production would deliver to `.catch` instead.
  readonly port: MediaFilePort = {
    readChunk: async (path, offset, length) => this.read(path).subarray(offset, offset + length),
    hashFile: async (path) => sha256Hex(this.read(path)),
    sizeOf: async (path) => this.read(path).byteLength,
    exists: (path) => Promise.resolve(this.files.has(path)),
    deleteFile: (path) => {
      this.files.delete(path);
      return Promise.resolve();
    },
  };

  /** Stands in for `moveCaptureToDocumentDir` — same contract: awaited, returns the NEW path. */
  moveToDocuments = (cacheUri: string, mediaId: string, extension: string): Promise<string> => {
    const bytes = this.read(cacheUri);
    const destination = `/documents/media/${mediaId}.${extension}`;
    this.files.delete(cacheUri);
    this.files.set(destination, bytes);
    this.moves.push({ from: cacheUri, to: destination });
    return Promise.resolve(destination);
  };

  writeToCache = (bytes: Uint8Array, mediaId: string, extension: string): string =>
    this.write(`/cache/media-capture/${mediaId}.${extension}`, bytes);
}

/**
 * A compressor that ACTUALLY re-encodes: the output is smaller than the input, and honours the
 * resize target's aspect-preserving semantics.
 *
 * `bytesPerPixel` is what makes the two-pass rule testable: a 12 MP source at pass 1's cap stays
 * over 300 KiB, so pass 2 fires — exactly the branch 06 §2.2 step 4 describes. The relationship is
 * a crude model of JPEG, not a claim about it; what is being tested is our BRANCH, and the branch
 * reads a measured file size either way.
 */
export class ShrinkingCompressor implements ImageCompressorPort {
  readonly calls: { uri: string; target: ResizeTarget; compress: number }[] = [];

  constructor(
    private readonly source: { width: number; height: number },
    private readonly fs: FakeFs,
    private readonly bytesPerPixel = 0.5,
  ) {}

  compress(uri: string, target: ResizeTarget, compress: number): Promise<CompressedImage> {
    this.calls.push({ uri, target, compress });
    const ratio = this.source.width / this.source.height;
    let width = this.source.width;
    let height = this.source.height;
    if (target !== null && 'width' in target) {
      width = target.width;
      height = Math.round(target.width / ratio);
    } else if (target !== null) {
      height = target.height;
      width = Math.round(target.height * ratio);
    }
    const size = Math.max(1, Math.round(width * height * this.bytesPerPixel * compress));
    const out = `/cache/manipulated-${this.calls.length}.jpg`;
    this.fs.write(out, bytesOfLength(size, this.calls.length + 1));
    return Promise.resolve({ uri: out, width, height });
  }
}

/** A `TimerPort` whose callbacks fire only when the test says so (T-6: a test that sleeps is a bug). */
export class FakeTimer implements TimerPort {
  private pending: { id: number; delayMs: number; fn: () => void }[] = [];
  private nextId = 1;

  schedule(delayMs: number, fn: () => void): () => void {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.push({ id, delayMs, fn });
    return () => {
      this.pending = this.pending.filter((entry) => entry.id !== id);
    };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Fire everything currently pending, once. Re-armed timers are NOT fired (no runaway intervals). */
  runPending(): void {
    const due = this.pending;
    this.pending = [];
    for (const entry of due) entry.fn();
  }
}

/** A `NetInfoPort` fake: fires immediately with the current state, then on `emit` (12.0.1 contract). */
export function fakeNetInfo(initial: boolean): {
  port: { subscribe: (listener: (connected: boolean) => void) => () => void };
  emit: (next: boolean) => void;
} {
  let connected = initial;
  const listeners = new Set<(c: boolean) => void>();
  return {
    port: {
      subscribe: (listener) => {
        listeners.add(listener);
        listener(connected);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(next) {
      connected = next;
      for (const listener of listeners) listener(next);
    },
  };
}

export const activeAppState = {
  current: () => 'active' as const,
  subscribe: () => () => undefined,
};

/**
 * A protocol-faithful in-memory implementation of api/03-media §3, served through a `fetch` stub.
 *
 * It is driven by the REAL `createFetchMediaTransport` (transport.ts) in `client.test.ts`, so an
 * upload that goes green there has crossed the real adapter — URL construction, the bearer header,
 * the `application/octet-stream` chunk body, the api/00 §7 error envelope — and not a hand-written
 * port double. That is the difference between "the engine works" (task 18 proved it) and "the
 * device wiring works" (this task's job).
 *
 * The server VERIFIES on `complete`: the assembled bytes must hash to the sha256 `init` declared,
 * or it answers `422 HASH_MISMATCH`. Without that check every chunking bug would still go green.
 */
export class FakeMediaServer {
  readonly sessions = new Map<
    string,
    { sizeBytes: number; sha256: string; chunks: Map<number, Uint8Array>; complete: boolean }
  >();
  readonly chunkSize: number;
  /** Every chunk PUT's `Content-Encoding` header, so a test can assert none was ever sent. */
  readonly chunkEncodings: (string | null)[] = [];

  constructor(chunkSize = 64) {
    this.chunkSize = chunkSize;
  }

  assembled(mediaId: string): Uint8Array {
    const session = this.sessions.get(mediaId);
    if (session === undefined) throw new Error(`no session ${mediaId}`);
    const total = Math.ceil(session.sizeBytes / this.chunkSize);
    const out = new Uint8Array(session.sizeBytes);
    let at = 0;
    for (let index = 0; index < total; index += 1) {
      const chunk = session.chunks.get(index);
      if (chunk === undefined) throw new Error(`missing chunk ${index}`);
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const initMatch = /\/v1\/media\/([^/]+)\/init$/.exec(url);
    const chunkMatch = /\/v1\/media\/([^/]+)\/chunks\/(\d+)$/.exec(url);
    const statusMatch = /\/v1\/media\/([^/]+)\/status$/.exec(url);
    const completeMatch = /\/v1\/media\/([^/]+)\/complete$/.exec(url);

    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const fail = (code: string, status: number): Response =>
      json({ error: { code, message: code } }, status);

    if (initMatch?.[1] !== undefined && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { sizeBytes: number; sha256: string };
      const id = initMatch[1];
      const existing = this.sessions.get(id);
      // api/03 §3.1: init is IDEMPOTENT by media id — a byte-identical re-init is the resume path.
      if (existing !== undefined && existing.sha256 !== body.sha256) {
        return fail('INIT_MISMATCH', 409);
      }
      const session = existing ?? {
        sizeBytes: body.sizeBytes,
        sha256: body.sha256,
        chunks: new Map<number, Uint8Array>(),
        complete: false,
      };
      this.sessions.set(id, session);
      return json({
        chunkSize: this.chunkSize,
        totalChunks: Math.ceil(session.sizeBytes / this.chunkSize),
        receivedChunks: [...session.chunks.keys()].sort((a, b) => a - b),
        status: session.complete ? 'complete' : 'receiving',
      });
    }

    if (chunkMatch?.[1] !== undefined && chunkMatch[2] !== undefined && method === 'PUT') {
      const session = this.sessions.get(chunkMatch[1]);
      if (session === undefined) return fail('MEDIA_NOT_FOUND', 404);
      const headers = new Headers(init?.headers as HeadersInit);
      this.chunkEncodings.push(headers.get('Content-Encoding'));
      const body = init?.body;
      if (!(body instanceof Uint8Array)) return fail('VALIDATION_FAILED', 422);
      session.chunks.set(Number(chunkMatch[2]), new Uint8Array(body));
      return json({ receivedChunks: [...session.chunks.keys()].sort((a, b) => a - b) });
    }

    if (statusMatch?.[1] !== undefined && method === 'GET') {
      const session = this.sessions.get(statusMatch[1]);
      if (session === undefined) return fail('MEDIA_NOT_FOUND', 404);
      return json({
        status: session.complete ? 'complete' : 'receiving',
        sizeBytes: session.sizeBytes,
        chunkSize: this.chunkSize,
        totalChunks: Math.ceil(session.sizeBytes / this.chunkSize),
        receivedChunks: [...session.chunks.keys()].sort((a, b) => a - b),
      });
    }

    if (completeMatch?.[1] !== undefined && method === 'POST') {
      const id = completeMatch[1];
      const session = this.sessions.get(id);
      if (session === undefined) return fail('MEDIA_NOT_FOUND', 404);
      const total = Math.ceil(session.sizeBytes / this.chunkSize);
      const missing = [...Array(total).keys()].filter((index) => !session.chunks.has(index));
      if (missing.length > 0) {
        return json(
          {
            error: {
              code: 'CHUNKS_MISSING',
              message: 'missing',
              details: { missingChunks: missing },
            },
          },
          422,
        );
      }
      // THE CHECK THAT MAKES A GREEN UPLOAD MEAN SOMETHING.
      if (sha256Hex(this.assembled(id)) !== session.sha256) return fail('HASH_MISMATCH', 422);
      session.complete = true;
      return json({ status: 'complete' });
    }

    return fail('NOT_FOUND', 404);
  };
}

// ── The fakes' own falsification ────────────────────────────────────────────────────────────────

describe('the fakes behave, so the suites built on them are not green for the wrong reason', () => {
  test('FakeFs REJECTS a missing file rather than hashing nothing (T-19)', async () => {
    const fs = new FakeFs();
    await expect(fs.port.hashFile('/nope')).rejects.toThrow('no such file');
    await expect(fs.port.sizeOf('/nope')).rejects.toThrow('no such file');
    // The specific value the real bug produced: the empty-string SHA-256, a real-looking hash.
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('ShrinkingCompressor really shrinks, and preserves aspect from ONE edge', async () => {
    const fs = new FakeFs();
    const compressor = new ShrinkingCompressor({ width: 4000, height: 3000 }, fs);
    fs.write('/cache/shot.jpg', bytesOfLength(9_000_000));
    const out = await compressor.compress('/cache/shot.jpg', { width: 1600 }, 0.7);
    expect(out.width).toBe(1600);
    expect(out.height).toBe(1200);
    expect(fs.read(out.uri).byteLength).toBeLessThan(fs.read('/cache/shot.jpg').byteLength);
  });

  test('FakeMediaServer rejects a completed upload whose bytes do not hash to init`s sha256', async () => {
    const server = new FakeMediaServer(4);
    const bytes = bytesOfLength(8);
    await server.fetch('https://x/v1/media/m1/init', {
      method: 'POST',
      body: JSON.stringify({ sizeBytes: 8, sha256: sha256Hex(bytes) }),
    });
    // Upload the RIGHT length but the WRONG content — the shape a chunking bug produces.
    await server.fetch('https://x/v1/media/m1/chunks/0', {
      method: 'PUT',
      body: bytesOfLength(4, 99),
    });
    await server.fetch('https://x/v1/media/m1/chunks/1', {
      method: 'PUT',
      body: bytesOfLength(4, 98),
    });
    const response = await server.fetch('https://x/v1/media/m1/complete', { method: 'POST' });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'HASH_MISMATCH',
    );
  });

  test('FakeTimer fires nothing until told, and a cancelled entry never fires', () => {
    const timer = new FakeTimer();
    let fired = 0;
    timer.schedule(3_000, () => {
      fired += 1;
    });
    const cancel = timer.schedule(3_000, () => {
      fired += 1;
    });
    cancel();
    expect(fired).toBe(0);
    timer.runPending();
    expect(fired).toBe(1);
  });

  test('MediaTransportError is what the adapter throws — the suites match on `code`, not status', () => {
    const error = new MediaTransportError('x', { code: 'CHUNKS_MISSING', status: 422 });
    expect(error.code).toBe('CHUNKS_MISSING');
  });
});
