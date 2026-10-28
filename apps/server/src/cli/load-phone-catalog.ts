// Load a phone catalog file (catalog/catalog-file.ts) into the catalog tables: the committed
// names-only seed, or the private full catalog with specs and photos.
//
//   DATABASE_URL=<owner URL> pnpm --filter @bolusi/server load-phone-catalog <file.ndjson[.gz]>
//
// Like the crawler it writes as the tables' owner (bolusi_provision). Safe to repeat and safe on
// a catalog devices already synced: only new or changed rows get new revisions.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { loadCatalogFile, parseCatalogFile } from '../catalog/catalog-file.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const [file] = args;
  if (file === undefined || args.length !== 1 || file.startsWith('--')) {
    process.stderr.write('load-phone-catalog <file.ndjson or file.ndjson.gz>\n');
    process.exit(2);
  }
  const raw = readFileSync(file);
  const lines = parseCatalogFile((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
  const { createPhoneCatalogWriter } = await import('@bolusi/db-server');
  const log = (line: string): void => {
    process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  };
  const summary = await loadCatalogFile(createPhoneCatalogWriter(), lines, Date.now(), log);
  log(
    `done: ${summary.brands} brands, ${summary.models} models (${summary.newModels} new), ${summary.details} with details, ${summary.photos} photos`,
  );
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('load-phone-catalog.ts') ||
  process.argv[1]?.endsWith('load-phone-catalog.js')
) {
  void main();
}
