// Where phones find their over-the-air updates: pre-releases of this repository tagged
// `mobile-ota-*` (the mobile-ota workflow). Each carries one `ota-<platform>.json` per platform with
// the manifest text and its signature, made with the update signing key in CI, plus the files the
// manifest lists. The server never signs anything: it picks the newest update made for the phone's
// native build (its runtime version) and hands it over byte for byte. The phone checks the
// signature against the certificate built into the app, and every file against its hash in the
// manifest, so neither GitHub nor this server can change what a phone runs.
import { z } from 'zod';

export const OTA_TAG_PREFIX = 'mobile-ota-';
export const OTA_PLATFORMS = ['android', 'ios'] as const;
export type OtaPlatform = (typeof OTA_PLATFORMS)[number];

/** One platform's update as the release carries it. */
const zReleaseUpdate = z
  .object({
    runtimeVersion: z.string().min(1).max(128),
    /** The manifest exactly as signed; parsed only to read its id. */
    manifest: z.string().min(2).max(1_000_000),
    /** The `expo-signature` header value: `sig="…", keyid="main"`. */
    signature: z.string().min(1).max(4_096),
  })
  .strict();

const zManifestId = z.object({ id: z.string().uuid() });

const zRelease = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string().url() })),
});

export interface SignedUpdate {
  readonly id: string;
  readonly manifest: string;
  readonly signature: string;
}

export interface UpdateSource {
  /** The newest update for this platform and native build, or null when there is none. */
  latest(platform: OtaPlatform, runtimeVersion: string): Promise<SignedUpdate | null>;
}

export interface GitHubReleaseSourceOptions {
  /** `owner/name`. */
  readonly repo: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** How long the release list is reused; phones check on every start. */
  readonly listTtlMs?: number;
}

const LIST_TTL_MS = 5 * 60_000;
/** Releases looked through for a phone's runtime version, newest first. */
const RELEASES_SCANNED = 30;

/**
 * Reads updates from GitHub Releases. The release list is cached for a few minutes (GitHub allows
 * 60 unauthenticated calls an hour), and a release's update file never changes once published, so
 * it is cached for good.
 */
export function gitHubReleaseSource(options: GitHubReleaseSourceOptions): UpdateSource {
  const get = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const ttl = options.listTtlMs ?? LIST_TTL_MS;
  let listed: { at: number; releases: Promise<z.infer<typeof zRelease>[]> } | null = null;
  const files = new Map<string, Promise<z.infer<typeof zReleaseUpdate> | null>>();

  const releases = (): Promise<z.infer<typeof zRelease>[]> => {
    if (listed !== null && now() - listed.at < ttl) return listed.releases;
    const url = `https://api.github.com/repos/${options.repo}/releases?per_page=${String(RELEASES_SCANNED)}`;
    const pending = get(url, { headers: { accept: 'application/vnd.github+json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub releases: ${String(response.status)}`);
        return z.array(zRelease).parse(await response.json());
      })
      .catch((error: unknown) => {
        // Not cached: the next phone asks again.
        listed = null;
        throw error;
      });
    listed = { at: now(), releases: pending };
    return pending;
  };

  const updateFile = (url: string): Promise<z.infer<typeof zReleaseUpdate> | null> => {
    let pending = files.get(url);
    if (pending === undefined) {
      pending = get(url).then(async (response) => {
        if (!response.ok) throw new Error(`GitHub release asset: ${String(response.status)}`);
        const parsed = zReleaseUpdate.safeParse(await response.json());
        return parsed.success ? parsed.data : null;
      });
      pending.catch(() => files.delete(url));
      files.set(url, pending);
    }
    return pending;
  };

  return {
    async latest(platform, runtimeVersion) {
      const fileName = `ota-${platform}.json`;
      for (const release of await releases()) {
        if (release.draft || !release.tag_name.startsWith(OTA_TAG_PREFIX)) continue;
        const asset = release.assets.find((candidate) => candidate.name === fileName);
        if (asset === undefined) continue;
        const update = await updateFile(asset.browser_download_url);
        if (update === null || update.runtimeVersion !== runtimeVersion) continue;
        const id = manifestId(update.manifest);
        if (id === null) continue;
        return { id, manifest: update.manifest, signature: update.signature };
      }
      return null;
    },
  };
}

function manifestId(text: string): string | null {
  try {
    const parsed = zManifestId.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.id : null;
  } catch {
    return null;
  }
}
