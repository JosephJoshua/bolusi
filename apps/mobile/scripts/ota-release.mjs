// Turns an `expo export` into the files of one phone update release (docs/app-updates.md): for each
// platform a signed `ota-<platform>.json`, plus every bundle and asset the manifests list, named by
// their SHA-256 so the release holds each file once. The mobile-ota workflow runs it and uploads
// the result to a `mobile-ota-*` pre-release; the server hands the manifests to phones as they are.
//
//   node apps/mobile/scripts/ota-release.mjs --dist <export dir> --out <dir> --base-url <url> \
//     --config <expo config json> --runtime android=<version> --runtime ios=<version>
//
// The signing key (PEM) comes from BOLUSI_OTA_PRIVATE_KEY and never touches the disk.
import { createHash, randomUUID, sign } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  otf: 'font/otf',
  json: 'application/json',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
};

const sha256 = (bytes) => createHash('sha256').update(bytes);

/** One file as a manifest lists it, and where its copy goes in the release. */
function describe(distDir, path, ext, contentType, baseUrl) {
  const bytes = readFileSync(join(distDir, path));
  const name = `${sha256(bytes).digest('hex')}.${ext}`;
  return {
    entry: {
      hash: sha256(bytes).digest('base64url'),
      key: createHash('md5').update(bytes).digest('hex'),
      contentType,
      fileExtension: `.${ext}`,
      url: `${baseUrl}/${name}`,
    },
    copy: { from: join(distDir, path), name },
  };
}

/**
 * Build one platform's signed update. `baseUrl` is where the release's files are downloaded from;
 * `privateKey` signs the manifest text exactly as phones will receive it.
 */
export function buildPlatformUpdate({
  distDir,
  metadata,
  platform,
  runtimeVersion,
  expoConfig,
  baseUrl,
  privateKey,
  id = randomUUID(),
  createdAt = new Date().toISOString(),
}) {
  const files = metadata.fileMetadata[platform];
  if (files === undefined) throw new Error(`the export has no ${platform} bundle`);
  const launch = describe(distDir, files.bundle, 'bundle', 'application/javascript', baseUrl);
  const assets = files.assets.map((asset) =>
    describe(
      distDir,
      asset.path,
      asset.ext,
      CONTENT_TYPES[asset.ext] ?? 'application/octet-stream',
      baseUrl,
    ),
  );
  const manifest = JSON.stringify({
    id,
    createdAt,
    runtimeVersion,
    launchAsset: launch.entry,
    assets: assets.map((asset) => asset.entry),
    metadata: {},
    extra: { expoClient: expoConfig },
  });
  const signature = sign('sha256', Buffer.from(manifest, 'utf8'), privateKey).toString('base64');
  return {
    file: { runtimeVersion, manifest, signature: `sig="${signature}", keyid="main"` },
    copies: [launch.copy, ...assets.map((asset) => asset.copy)],
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      dist: { type: 'string' },
      out: { type: 'string' },
      'base-url': { type: 'string' },
      config: { type: 'string' },
      runtime: { type: 'string', multiple: true },
    },
  });
  const privateKey = process.env.BOLUSI_OTA_PRIVATE_KEY;
  if (!values.dist || !values.out || !values['base-url'] || !values.config || !values.runtime) {
    throw new Error('usage: --dist --out --base-url --config --runtime <platform>=<version>...');
  }
  if (!privateKey) throw new Error('Set BOLUSI_OTA_PRIVATE_KEY to the update signing key (PEM)');
  const metadata = JSON.parse(readFileSync(join(values.dist, 'metadata.json'), 'utf8'));
  const expoConfig = JSON.parse(readFileSync(values.config, 'utf8'));
  mkdirSync(values.out, { recursive: true });
  for (const pair of values.runtime) {
    const [platform, runtimeVersion] = pair.split('=');
    const { file, copies } = buildPlatformUpdate({
      distDir: values.dist,
      metadata,
      platform,
      runtimeVersion,
      expoConfig,
      baseUrl: values['base-url'].replace(/\/+$/, ''),
      privateKey,
    });
    for (const copy of copies) copyFileSync(copy.from, join(values.out, copy.name));
    writeFileSync(join(values.out, `ota-${platform}.json`), `${JSON.stringify(file)}\n`);
    console.log(`${platform}: ${copies.length} files, runtime ${runtimeVersion}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
