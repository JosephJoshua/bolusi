// The `MediaFilePort` adapter — expo-file-system SDK 57 (06-media-pipeline §2.2 step 6, §5.5).
//
// VERIFIED AGAINST THE SDK 57 API, not from memory (CLAUDE.md §1; this repo has shipped three
// well-typed no-ops). What was checked and what it says:
//   • `File.open()` → `FileHandle` with a settable `offset` and `readBytes(length)`. Supported
//     platforms: Android, iOS, tvOS. `readBytes` returns `Uint8Array` **synchronously** — it is NOT
//     a Promise (File.types.d.ts:82). This is the whole basis of 06 §5.5's "the file is never
//     loaded whole into memory".
//   • `File#move()` returns **`Promise<void>`** (NativeFileSystem.types.d.ts:61) and MUST be
//     awaited; `moveSync()` (:65) is the void one. Getting this wrong destroys evidence — see
//     `moveCaptureToDocumentDir`.
//   • `File#size` is **`number`**, not `number | null`, on the exported class — so a `size === null`
//     guard is dead code. (The `number | null` at File.types.d.ts:85 is a different declaration and
//     does not win.)
// The three above were established by COMPILER PROBE against the installed types — writing a file
// that assigns each expression to `1` and reading what tsc says it actually is — not by reading a
// `.d.ts` and picking the overload that looked right. Two of the three contradicted what this
// header originally asserted (§2.11: a comment is a hypothesis, not evidence).
//   • `Paths.availableDiskSpace` / `Paths.totalDiskSpace` — bytes, Android/iOS/tvOS. The LEGACY
//     `getFreeDiskStorageAsync` is deprecated and **throws at runtime** in SDK 54+ ("This method
//     will throw in runtime") unless imported from `expo-file-system/legacy` — which `bolusi/
//     boundaries` bans outright (08 §2.2). Reaching for the familiar name would compile and then
//     throw on a technician's phone.
// `FileHandle.close()` is not optional bookkeeping: an unclosed handle leaks a native fd, and the
// drain loop opens one per chunk on a 2 GB device.
//
// WHAT THIS FILE CANNOT PROVE — stated plainly, because the notice that stood here was a decoy:
//
//   **THIS FILE HAS NO TESTS AND NO CALLERS.** There is no `files.test.ts`, no
//   `vi.mock('expo-file-system')` anywhere in the repo, and nothing imports these exports yet. The
//   capture pipeline, drain triggers and pruning pass that will call them are the mobile half of
//   task 18, which is NOT shipped. Every line below is type-checked and unexecuted.
//
// The previous notice claimed assertions ran "against a MOCKED expo-file-system in Node" and that
// "the tests stay green" — vacuously true over ZERO assertions, while reading as "a mock-backed
// suite exists, here is its limit". That framing is why a floating `move()` — the very bug
// `moveCaptureToDocumentDir`'s own header warns about — survived to review. A false reassurance is
// worse than none: it converts an unknown risk into a stated, bounded-sounding one.
//
// On top of that, and independently: no physical Android device is available (D12/D13), so even
// once tests exist, nothing here is device-verified.
import { Directory, File, Paths } from 'expo-file-system';
import type { MediaFilePort } from '@bolusi/core';
import { createHash } from 'react-native-quick-crypto';

/** 06 §2.2 step 6: streamed hashing in 256 KiB reads. */
const HASH_READ_SIZE = 256 * 1024;

/** `<documentDirectory>/media/` — self-captured evidence (06 §2.2 step 5). NEVER the cache dir. */
export function mediaDocumentDirectory(): Directory {
  return new Directory(Paths.document, 'media');
}

/** `<cacheDirectory>/media/` — the remote render cache ONLY (06 §6); always evictable. */
export function mediaCacheDirectory(): Directory {
  return new Directory(Paths.cache, 'media');
}

/**
 * `<cacheDirectory>/media-capture/` — the scratch directory a signature is encoded into before
 * §2.2 step 5 moves it. DELIBERATELY NOT `mediaCacheDirectory()`: that one is the remote render
 * cache, which 06 §6 declares "always evictable — the OS or the pruning pass may drop them freely;
 * they are re-fetchable". A freshly encoded signature is the opposite of re-fetchable, and a
 * pruning pass that swept the render cache would delete evidence that has not reached the server
 * if the two shared a directory. Separate names, separate lifetimes.
 */
function captureScratchDirectory(): Directory {
  return new Directory(Paths.cache, 'media-capture');
}

/**
 * Write freshly encoded bytes (a signature PNG — 06 §2.3) into the capture scratch directory and
 * return its uri, so the SAME cache→document move photos use (`moveCaptureToDocumentDir`) applies
 * to signatures too. §2.3 says signatures share "§2.2 steps 2, 5–8" verbatim; one move path is how
 * that sentence stays true rather than becoming two half-implementations (§2.8).
 *
 * SYNCHRONOUS, and declared so. `File#write`, `File#create` and `Directory#create` all return
 * `void` in SDK 57 (internal/NativeFileSystem.types.d.ts:155/178/43) — unlike `move()`, which
 * returns a promise and must be awaited. Both spellings sit in this one file, so the asymmetry is
 * stated rather than left for the next reader to assume. An `async` wrapper with nothing to await
 * would be the well-typed decoration §2.11 keeps catching: it would imply this can fail later, and
 * invite a caller to think a floating call is harmless here the way it was fatal ten lines down.
 */
export function writeCaptureToCache(bytes: Uint8Array, mediaId: string, extension: string): string {
  const dir = captureScratchDirectory();
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, `${mediaId}.${extension}`);
  if (!file.exists) file.create();
  file.write(bytes);
  return file.uri;
}

/** Free space in bytes (06 §7). `Paths.availableDiskSpace`, not the throwing legacy API. */
export function availableDiskSpaceBytes(): number {
  return Paths.availableDiskSpace;
}

/**
 * The remote render cache's on-disk face (06 §6) — read, write, list, evict.
 *
 * All four live together because they share one naming rule (`<mediaId>.<ext>` in
 * `mediaCacheDirectory()`), and a rule split across four call sites is a rule that drifts. The id
 * is recovered by cutting at the FIRST dot, which is safe because the id is a UUIDv7 (hyphens, hex,
 * no dots) — stated because "split on the last dot" would be the reflex and would be wrong for a
 * hypothetical `<id>.tar.gz`.
 */
export const remoteMediaCache = {
  /** The cached file's uri, or `null` if it is not cached. NEVER a path to a file that is absent. */
  find(mediaId: string, extension: string): string | null {
    const file = new File(mediaCacheDirectory(), `${mediaId}.${extension}`);
    return file.exists ? file.uri : null;
  },

  /** Write verified bytes into the cache. Synchronous, like every `File#write` (see below). */
  write(mediaId: string, extension: string, bytes: Uint8Array): string {
    const dir = mediaCacheDirectory();
    if (!dir.exists) dir.create({ intermediates: true });
    const file = new File(dir, `${mediaId}.${extension}`);
    if (!file.exists) file.create();
    file.write(bytes);
    return file.uri;
  },

  /**
   * Cache contents for §7's oldest-first eviction.
   *
   * `modificationTime` is `number | null` in SDK 57 (internal/NativeFileSystem.types.d.ts:231). The
   * null is mapped to `0` — sort first, evict first — and that mapping is deliberate and bounded:
   * this cache is re-fetchable by definition (06 §6), so an entry of unknown age evicted early
   * costs one download. This is the ONLY `||`-shaped default in the media code and it is here
   * rather than in `pruning.ts` so the whole T-19 argument sits next to the platform value it is
   * about.
   */
  list(): readonly { id: string; lastUsedAt: number }[] {
    const dir = mediaCacheDirectory();
    if (!dir.exists) return [];
    const entries: { id: string; lastUsedAt: number }[] = [];
    for (const entry of dir.list()) {
      if (!(entry instanceof File)) continue;
      const id = entry.name.split('.')[0];
      if (id === undefined || id === '') continue;
      const modified = entry.modificationTime;
      entries.push({ id, lastUsedAt: modified === null ? 0 : modified });
    }
    return entries;
  },

  /** Evict by id, whatever the extension. A missing entry is success — eviction is idempotent. */
  evict(mediaId: string): void {
    const dir = mediaCacheDirectory();
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      if (entry instanceof File && entry.name.split('.')[0] === mediaId) entry.delete();
    }
  },
};

export const expoMediaFilePort: MediaFilePort = {
  /**
   * A RANDOM-ACCESS read — the contract `MediaFilePort` states and the reason it exists. Opening a
   * handle, seeking, and reading `length` bytes keeps peak memory at one chunk (256 KiB) rather
   * than one file (up to 10 MiB, api/03 §3.1). An adapter that read the file whole and sliced
   * would satisfy the interface and violate 06 §5.5 on the exact device class this product targets.
   */
  async readChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
    const handle = new File(path).open();
    try {
      handle.offset = offset;
      return await handle.readBytes(length);
    } finally {
      handle.close();
    }
  },

  /**
   * SHA-256 over the file's current bytes, in 256 KiB reads (06 §2.2 step 6).
   *
   * BOTH HALVES ARE SYNCHRONOUS: quick-crypto's `createHash` is a sync digest (06 §2.2 step 6 pins
   * it) and `FileHandle.readBytes` returns `Uint8Array`, NOT a Promise (File.types.d.ts:82 —
   * verified by compiler probe, not by reading the docs). An earlier version of this comment said
   * "the READS are async", which was simply false. The method stays `async` because `MediaFilePort`
   * is an async interface, not because anything here awaits.
   *
   * What survives that correction is the reason the loop exists at all: reading in 256 KiB slices
   * keeps peak memory at one slice, where `new File(path).bytes()` would pull up to 10 MiB
   * (api/03 §3.1's cap) into JS memory on a 2 GB device. The hash is computed over the FINAL bytes
   * and the file is never touched again (06 §2.2: "Never re-touch the bytes after hashing").
   *
   * Fails closed on a missing file rather than hashing nothing: `size` is `number` (not nullable —
   * see `sizeOf`), so a missing file would sail through the loop zero times and return the
   * **empty-string SHA-256**, a real-looking hash that matches nothing. That value would reach
   * `HASH_MISMATCH` re-hashing (06 §5.1) and be read as "the local file rotted" — a plausible wrong
   * answer instead of an error, which is the failure mode this repo keeps shipping.
   */
  async hashFile(path: string): Promise<string> {
    const file = new File(path);
    if (!file.exists) throw new Error(`cannot hash missing file ${path}`);
    const size = file.size;
    const handle = file.open();
    try {
      const hash = createHash('sha256');
      let read = 0;
      while (read < size) {
        handle.offset = read;
        const chunk = handle.readBytes(Math.min(HASH_READ_SIZE, size - read));
        if (chunk.byteLength === 0) break; // defensive: a truncated file must not spin forever
        hash.update(chunk);
        read += chunk.byteLength;
      }
      return hash.digest('hex');
    } finally {
      handle.close();
    }
  },

  /**
   * Size in bytes; REJECTS if absent — the contract `MediaFilePort.sizeOf` states.
   *
   * The guard is `exists`, not `size === null`. `File.size` is typed `number` on the exported class
   * (compiler probe: `f.size` resolves to `number`; the `number | null` at File.types.d.ts:85 is a
   * different declaration and does not win), so a `if (size === null) throw` here was **dead code** —
   * it could never fire, and `sizeOf('/missing')` returned **0** instead of rejecting, silently
   * violating the port's contract. tsc cannot see this class of bug: the check is well-typed and
   * irrelevant (T-15's "well-typed no-op"). Caught in review, not by a test.
   */
  async sizeOf(path: string): Promise<number> {
    const file = new File(path);
    if (!file.exists) throw new Error(`cannot size missing file ${path}`);
    return file.size;
  },

  async exists(path: string): Promise<boolean> {
    return new File(path).exists;
  },

  /** A missing file is NOT an error — the pruning pass must be idempotent (06 §7). */
  async deleteFile(path: string): Promise<void> {
    const file = new File(path);
    if (file.exists) file.delete();
  },
};

/**
 * 06 §2.2 step 5 — move cache → document dir, "**immediately**, before anything else references
 * the file".
 *
 * THE ORDERING IS THE POINT, and it is a security property, not tidiness: `takePictureAsync` and
 * the manipulator both write to the app CACHE directory, which the OS may purge at any time
 * (security-guide §7.1: "cache is OS-purgeable; a purged evidence photo is destroyed evidence").
 * The move must therefore complete BEFORE the `MediaItem` row is inserted — so a crash between
 * capture and move loses the photo cleanly rather than leaving a row pointing at a path the OS is
 * free to delete. 06 §10's checklist names exactly that: "crash between capture and move loses the
 * photo cleanly, never a dangling row".
 *
 * Returns the new document-dir path. The caller inserts the row only after this resolves.
 */
export async function moveCaptureToDocumentDir(
  cacheUri: string,
  mediaId: string,
  extension: string,
): Promise<string> {
  const dir = mediaDocumentDirectory();
  if (!dir.exists) dir.create({ intermediates: true });
  const source = new File(cacheUri);
  const destination = new File(dir, `${mediaId}.${extension}`);
  // AWAITED. `move()` returns `Promise<void>` (NativeFileSystem.types.d.ts:61; `moveSync()` at :65
  // is the void one). A floating call would let this function RESOLVE AND RETURN THE URI BEFORE THE
  // MOVE COMPLETED — the caller would then insert a MediaItem row pointing into the OS-purgeable
  // cache dir, the OS would purge it, and a shop's only record of a repair would be gone. It would
  // also swallow a rejection. This exact bug shipped here and was caught in review: the header six
  // lines above states the ordering rule, and the code below it broke that rule — `notifications.ts`
  // verbatim (§2.11: the comment was the guard). `@typescript-eslint/no-floating-promises` now
  // covers apps/mobile/src (tooling/eslint/src/index.js), so the class is closed by construction.
  await source.move(destination);
  return destination.uri;
}
