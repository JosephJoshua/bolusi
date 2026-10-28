// The PC's media files, the Node twin of the phone's `media/files.ts`: photos and signatures are
// sealed on disk with the key derived from the database key (core's `EncryptingMediaFile`), kept in
// the app's data folder, and handed to the window as `data:` URIs. Nothing decrypted is ever
// written to disk, so there are no render temps to clear.
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import {
  deriveMediaFileKey,
  EncryptingMediaFile,
  hexToBytes,
  MediaFileCipher,
  type MediaFilePort,
  type RawMediaFileIo,
  type Sha256Factory,
} from '@bolusi/core';
import type { MediaClientDeps } from '@bolusi/device/media/client';
import { MEDIA_EXTENSION } from '@bolusi/schemas';
import type { PhonePhotoFiles } from '@bolusi/device/media/phone-photos';

import { nodeColumnAead } from './crypto.js';

const sha256Factory: Sha256Factory = () => {
  const hash = createHash('sha256');
  return {
    update: (bytes) => {
      hash.update(bytes);
    },
    digestHex: () => hash.digest('hex'),
  };
};

const rawIo: RawMediaFileIo = {
  size: (path) => Promise.resolve(statSync(path).size),
  openRead(path) {
    const fd = openSync(path, 'r');
    return Promise.resolve({
      read(offset, length) {
        const buffer = Buffer.alloc(length);
        const read = readSync(fd, buffer, 0, length, offset);
        return Promise.resolve(new Uint8Array(buffer.buffer, buffer.byteOffset, read));
      },
      close: () => Promise.resolve(closeSync(fd)),
    });
  },
  openWrite(path) {
    const fd = openSync(path, 'w');
    return Promise.resolve({
      write: (bytes) => Promise.resolve(void writeSync(fd, bytes)),
      close: () => Promise.resolve(closeSync(fd)),
    });
  },
  exists: (path) => Promise.resolve(existsSync(path)),
  delete: (path) => Promise.resolve(rmSync(path, { force: true })),
};

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpeg: 'image/jpeg',
  ...Object.fromEntries(Object.entries(MEDIA_EXTENSION).map(([mime, ext]) => [ext, mime])),
};

export type DesktopMediaFiles = Pick<
  MediaClientDeps,
  | 'files'
  | 'freeSpaceBytes'
  | 'moveToDocuments'
  | 'writeToCache'
  | 'findCached'
  | 'writeCached'
  | 'evictCached'
  | 'listRemoteCache'
  | 'toRenderUri'
  | 'clearRenderTemps'
>;

/** Media folders under `root`: kept photos, the evictable download cache, and capture scratch. */
export function createDesktopMediaFiles(
  root: string,
  dbKeyHex: () => Promise<string | null>,
): DesktopMediaFiles {
  const documents = join(root, 'media');
  const cache = join(root, 'media-cache');
  const scratch = join(root, 'media-capture');
  const ensure = (dir: string): string => {
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  let enc: EncryptingMediaFile | null = null;
  const resolveEnc = async (): Promise<EncryptingMediaFile> => {
    if (enc !== null) return enc;
    const hex = await dbKeyHex();
    if (hex === null) throw new Error('media encryption unavailable: no database key');
    const cipher = new MediaFileCipher(
      deriveMediaFileKey(nodeColumnAead, hexToBytes(hex)),
      nodeColumnAead,
    );
    enc = new EncryptingMediaFile(cipher, rawIo, sha256Factory);
    return enc;
  };

  const files: MediaFilePort = {
    readChunk: async (path, offset, length) => (await resolveEnc()).readChunk(path, offset, length),
    hashFile: async (path) => (await resolveEnc()).hashFile(path),
    sizeOf: async (path) => (await resolveEnc()).sizeOf(path),
    exists: (path) => Promise.resolve(existsSync(path)),
    deleteFile: (path) => Promise.resolve(rmSync(path, { force: true })),
  };

  return {
    files,
    freeSpaceBytes() {
      const stats = statfsSync(ensure(root));
      return stats.bavail * stats.bsize;
    },
    writeToCache(bytes, mediaId, extension) {
      const path = join(ensure(scratch), `${mediaId}.${extension}`);
      writeFileSync(path, bytes);
      return path;
    },
    async moveToDocuments(cachePath, mediaId, extension) {
      const destination = join(ensure(documents), `${mediaId}.${extension}`);
      await (await resolveEnc()).encryptPlaintextFileTo(cachePath, destination);
      return destination;
    },
    findCached(mediaId, extension) {
      const path = join(cache, `${mediaId}.${extension}`);
      return existsSync(path) ? path : null;
    },
    async writeCached(mediaId, extension, bytes) {
      const path = join(ensure(cache), `${mediaId}.${extension}`);
      await (await resolveEnc()).encryptToFile(path, bytes);
      return path;
    },
    evictCached(mediaId) {
      if (!existsSync(cache)) return;
      for (const name of readdirSync(cache)) {
        if (name.split('.')[0] === mediaId) rmSync(join(cache, name), { force: true });
      }
    },
    listRemoteCache() {
      if (!existsSync(cache)) return [];
      return readdirSync(cache).flatMap((name) => {
        const id = name.split('.')[0];
        if (id === undefined || id === '') return [];
        return [{ id, lastUsedAt: statSync(join(cache, name)).mtimeMs }];
      });
    },
    async toRenderUri(path) {
      const plaintext = await (await resolveEnc()).decryptToBuffer(path);
      const extension = basename(path).split('.').pop() ?? '';
      const mime = MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
      return `data:${mime};base64,${Buffer.from(plaintext).toString('base64')}`;
    },
    clearRenderTemps: () => undefined,
  };
}

/** Catalog phone photos (public pictures, not sealed), cached in their own folder. */
export function createDesktopPhonePhotoFiles(root: string): PhonePhotoFiles {
  const dir = join(root, 'phone-models');
  return {
    find(name) {
      const path = join(dir, name);
      return existsSync(path) ? path : null;
    },
    write(name, bytes) {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, name);
      writeFileSync(path, bytes);
      return path;
    },
  };
}
