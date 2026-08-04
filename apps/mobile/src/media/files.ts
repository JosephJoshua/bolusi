// The `MediaFilePort` adapter — expo-file-system SDK 57 (06-media-pipeline §2.2 step 6, §5.5) — now
// ENCRYPTING at rest (task 158, SEC-MEDIA-09). Captured media files under `<documentDirectory>/media/`
// and the render cache under `<cacheDirectory>/media/` are AES-256-GCM ciphertext on disk; the crypto
// is the platform-free `EncryptingMediaFile` (packages/core, proven against an in-memory store) bound
// here to expo `FileHandle` raw IO and the device `deviceColumnAead`, keyed by a SIBLING of the
// SecureStore DB key. This file is the native glue; the security property is proven in core.
//
// NOTHING HERE IS DEVICE-VERIFIED (D12/D13): every expo call is type-checked against the installed SDK
// 57 declarations and unexecuted. The encrypt/decrypt LOGIC does run — in the core lane, over the raw
// store fake. That expo-file-system writes these exact bytes on a device is emulator-deferred (D21,
// the SEC-AUTH-09 posture).
//
// VERIFIED SDK 57 API (compiler probe, not memory): `File.open()` → `FileHandle` with settable
// `offset`, `readBytes(length): Uint8Array` (SYNC) and `writeBytes(bytes): void` (SYNC, File.types
// .d.ts:83); `File#write`/`#create`/`Directory#create` return void; `File#size` is `number`;
// `FileHandle.close()` releases a native fd (the drain opens one per chunk on a 2 GB device).
// `Paths.availableDiskSpace` — not the throwing legacy API (`getFreeDiskStorageAsync` throws in SDK 54+).
import { Directory, File, Paths } from 'expo-file-system';
import {
  deriveMediaFileKey,
  EncryptingMediaFile,
  hexToBytes,
  MediaFileCipher,
  type MediaFilePort,
  type RawMediaFileIo,
  type RawReadHandle,
  type RawWriteHandle,
} from '@bolusi/core';
import { createHash } from 'react-native-quick-crypto';

import { deviceColumnAead } from '../ports/aead.js';

/** `<documentDirectory>/media/` — self-captured evidence (06 §2.2 step 5). Encrypted at rest. */
export function mediaDocumentDirectory(): Directory {
  return new Directory(Paths.document, 'media');
}

/** `<cacheDirectory>/media/` — the remote render cache (06 §6); encrypted at rest, evictable. */
export function mediaCacheDirectory(): Directory {
  return new Directory(Paths.cache, 'media');
}

/**
 * `<cacheDirectory>/media-capture/` — the PLAINTEXT scratch a signature is encoded into before §2.2
 * step 5 moves it. Plaintext only transiently: `moveToDocuments` encrypts it into the document dir and
 * DELETES it. Separate from `mediaCacheDirectory()` (the evictable render cache) so a pruning pass over
 * the render cache can never delete un-uploaded evidence.
 */
function captureScratchDirectory(): Directory {
  return new Directory(Paths.cache, 'media-capture');
}

/**
 * `<cacheDirectory>/media-render/` — transient PLAINTEXT temps the OS image loader reads (task 158). A
 * rendered file is decrypted here just long enough for `<Image>` to decode it; the directory is in the
 * OS-evictable cache and is re-derivable from the encrypted source, so losing a temp costs one decrypt.
 * This is the accepted render-window residual of encrypting at rest.
 */
function renderTempDirectory(): Directory {
  return new Directory(Paths.cache, 'media-render');
}

/** Free space in bytes (06 §7). `Paths.availableDiskSpace`, not the throwing legacy API. */
export function availableDiskSpaceBytes(): number {
  return Paths.availableDiskSpace;
}

/** SHA-256 over PLAINTEXT via quick-crypto's sync digest — injected into `EncryptingMediaFile`. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The raw byte seam over expo `FileHandle`. Every method is over the ENCRYPTED on-disk bytes — no
 * method sees plaintext. `readBytes`/`writeBytes` are synchronous in SDK 57; the async signatures are
 * the `RawMediaFileIo` contract (a port may be async), not an await.
 */
const rawMediaFileIo: RawMediaFileIo = {
  async size(path: string): Promise<number> {
    const file = new File(path);
    if (!file.exists) throw new Error(`cannot size missing file ${path}`);
    return file.size;
  },
  async openRead(path: string): Promise<RawReadHandle> {
    const handle = new File(path).open();
    return {
      read: async (offset, length) => {
        handle.offset = offset;
        return handle.readBytes(length);
      },
      close: async () => {
        handle.close();
      },
    };
  },
  async openWrite(path: string): Promise<RawWriteHandle> {
    const file = new File(path);
    if (!file.exists) file.create();
    const handle = file.open();
    handle.offset = 0;
    return {
      write: async (bytes) => {
        handle.writeBytes(bytes);
      },
      close: async () => {
        handle.close();
      },
    };
  },
  async exists(path: string): Promise<boolean> {
    return new File(path).exists;
  },
  async delete(path: string): Promise<void> {
    const file = new File(path);
    if (file.exists) file.delete();
  },
};

export interface RemoteCacheEntry {
  readonly id: string;
  readonly lastUsedAt: number;
}

export interface EncryptingMediaFileParts {
  readonly port: MediaFilePort;
  readonly writeToCache: (bytes: Uint8Array, mediaId: string, extension: string) => string;
  readonly moveToDocuments: (
    cacheUri: string,
    mediaId: string,
    extension: string,
  ) => Promise<string>;
  readonly findCached: (mediaId: string, extension: string) => string | null;
  readonly writeCached: (mediaId: string, extension: string, bytes: Uint8Array) => Promise<string>;
  readonly evictCached: (mediaId: string) => void;
  readonly listRemoteCache: () => readonly RemoteCacheEntry[];
  readonly toRenderUri: (path: string) => Promise<string>;
}

/**
 * Every media-file part, bound to the media-file cipher (task 158). The key is a SIBLING of the DB key
 * (`deriveMediaFileKey`) so a media-file leak is not the DB-column key. It is read lazily on first file
 * op and memoised: it is present after `bootstrap` (which mints/reads it, §6.4), and its absence is a
 * fail-closed error (SEC-DEV-06 — never a plaintext fallback).
 */
export function createEncryptingMediaFileParts(
  dbKeyHex: () => Promise<string | null>,
): EncryptingMediaFileParts {
  let enc: EncryptingMediaFile | null = null;

  async function resolveEnc(): Promise<EncryptingMediaFile> {
    if (enc !== null) return enc;
    const hex = await dbKeyHex();
    if (hex === null) {
      throw new Error('media-file encryption unavailable: the at-rest DB key is not present');
    }
    const cipher = new MediaFileCipher(
      deriveMediaFileKey(deviceColumnAead, hexToBytes(hex)),
      deviceColumnAead,
    );
    enc = new EncryptingMediaFile(cipher, rawMediaFileIo, sha256Hex);
    return enc;
  }

  const port: MediaFilePort = {
    async readChunk(path, offset, length) {
      return (await resolveEnc()).readChunk(path, offset, length);
    },
    async hashFile(path) {
      return (await resolveEnc()).hashFile(path);
    },
    async sizeOf(path) {
      return (await resolveEnc()).sizeOf(path);
    },
    async exists(path) {
      return new File(path).exists;
    },
    async deleteFile(path) {
      const file = new File(path);
      if (file.exists) file.delete();
    },
  };

  return {
    port,

    /**
     * Write a signature PNG into the PLAINTEXT capture scratch (06 §2.3) — plaintext only until the
     * move encrypts it. Synchronous, like every `File#write`. The photo path never touches this: its
     * source is the image-manipulator cache output.
     */
    writeToCache(bytes, mediaId, extension) {
      const dir = captureScratchDirectory();
      if (!dir.exists) dir.create({ intermediates: true });
      const file = new File(dir, `${mediaId}.${extension}`);
      if (!file.exists) file.create();
      file.write(bytes);
      return file.uri;
    },

    /**
     * 06 §2.2 step 5 — cache → document dir, ENCRYPTING (task 158). The plaintext capture source is
     * re-encrypted frame-by-frame into the document-dir evidence file and then DELETED, so no plaintext
     * evidence file survives the move. Returns the new path; the caller inserts the row only after this
     * resolves (the ordering the old plaintext `move()` guarded, now upheld by `encryptPlaintextFileTo`).
     */
    async moveToDocuments(cacheUri, mediaId, extension) {
      const dir = mediaDocumentDirectory();
      if (!dir.exists) dir.create({ intermediates: true });
      const destination = new File(dir, `${mediaId}.${extension}`);
      await (await resolveEnc()).encryptPlaintextFileTo(cacheUri, destination.uri);
      return destination.uri;
    },

    /** A cached file's uri if present, else null. NEVER a path to an absent file. */
    findCached(mediaId, extension) {
      const file = new File(mediaCacheDirectory(), `${mediaId}.${extension}`);
      return file.exists ? file.uri : null;
    },

    /**
     * Write verified downloaded bytes into the render cache, ENCRYPTED (task 158). Async because
     * encryption resolves the cipher; the read paths (`port`/`toRenderUri`) decrypt.
     */
    async writeCached(mediaId, extension, bytes) {
      const dir = mediaCacheDirectory();
      if (!dir.exists) dir.create({ intermediates: true });
      const file = new File(dir, `${mediaId}.${extension}`);
      await (await resolveEnc()).encryptToFile(file.uri, bytes);
      return file.uri;
    },

    /** Evict by id, whatever the extension. A missing entry is success — eviction is idempotent. */
    evictCached(mediaId) {
      const dir = mediaCacheDirectory();
      if (!dir.exists) return;
      for (const entry of dir.list()) {
        if (entry instanceof File && entry.name.split('.')[0] === mediaId) entry.delete();
      }
    },

    /**
     * Render cache contents for §7's oldest-first eviction. `modificationTime` is `number | null` in
     * SDK 57; null maps to 0 (evict first) — bounded because this cache is re-fetchable (06 §6).
     */
    listRemoteCache() {
      const dir = mediaCacheDirectory();
      if (!dir.exists) return [];
      const entries: RemoteCacheEntry[] = [];
      for (const entry of dir.list()) {
        if (!(entry instanceof File)) continue;
        const id = entry.name.split('.')[0];
        if (id === undefined || id === '') continue;
        const modified = entry.modificationTime;
        entries.push({ id, lastUsedAt: modified === null ? 0 : modified });
      }
      return entries;
    },

    /**
     * Decrypt a verified media file to a transient plaintext temp and return its uri for `<Image>`
     * (task 158). Called only after the bytes were hash-verified (remote-cache.ts); decryption follows
     * verification, never replaces it. A v0 photo is ≤ 300 KiB, so buffering the plaintext to write the
     * temp is bounded; a v1 video would stream to the temp instead (06 §7 tripwire).
     */
    async toRenderUri(path) {
      const plaintext = await (await resolveEnc()).decryptToBuffer(path);
      const dir = renderTempDirectory();
      if (!dir.exists) dir.create({ intermediates: true });
      const temp = new File(dir, new File(path).name);
      if (!temp.exists) temp.create();
      temp.write(plaintext);
      return temp.uri;
    },
  };
}
