// Phone model photos for the intake screen (repair device-models.ts), fetched the first time one
// is shown and kept in the OS-evictable cache directory.
//
// These are catalog pictures of a phone model, not evidence: public, the same for every tenant, so
// they are stored plainly, unlike captured media (files.ts). Each is still checked against the
// hash the catalog row carries before it is kept, so a cut-off or swapped download never shows,
// and the file name carries that hash, so a new photo for a model never reuses the old file.
import type { DeviceModelPhoto } from '@bolusi/modules/repair';

/** Where the files live; the device binding is `phonePhotoFiles` (files.ts). */
export interface PhonePhotoFiles {
  /** The uri of `name` if it is present. */
  find(name: string): string | null;
  /** Store `bytes` as `name`; returns its uri. */
  write(name: string, bytes: Uint8Array): string;
}

export interface PhonePhotoLoaderDeps {
  readonly baseUrl: string;
  readonly deviceToken: () => Promise<string | null>;
  readonly sha256Hex: (bytes: Uint8Array) => string;
  readonly files: PhonePhotoFiles;
  readonly fetchImpl?: typeof fetch;
}

/** A displayable uri for the photo, or null when it cannot be had right now (offline, missing). */
export type PhonePhotoLoader = (photo: DeviceModelPhoto) => Promise<string | null>;

export function createPhonePhotoLoader(deps: PhonePhotoLoaderDeps): PhonePhotoLoader {
  const doFetch = deps.fetchImpl ?? fetch;
  // One download per photo however many rows show it at once; a failure is forgotten so the next
  // showing tries again.
  const inFlight = new Map<string, Promise<string | null>>();

  async function download(photo: DeviceModelPhoto, name: string): Promise<string | null> {
    const token = await deps.deviceToken();
    if (token === null) return null;
    const response = await doFetch(`${deps.baseUrl}/v1/catalog/phones/${photo.modelId}/photo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (deps.sha256Hex(bytes) !== photo.sha256) return null;
    return deps.files.write(name, bytes);
  }

  return (photo) => {
    if (!Number.isInteger(photo.modelId) || !/^[0-9a-f]{64}$/.test(photo.sha256)) {
      return Promise.resolve(null);
    }
    const name = `${photo.modelId}-${photo.sha256}`;
    const cached = deps.files.find(name);
    if (cached !== null) return Promise.resolve(cached);
    let pending = inFlight.get(name);
    if (pending === undefined) {
      pending = download(photo, name)
        .catch(() => null)
        .finally(() => inFlight.delete(name));
      inFlight.set(name, pending);
    }
    return pending;
  };
}
