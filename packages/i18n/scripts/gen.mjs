// Bundle JSON catalogs as a plain TS module for Node and native clients.
// Key types are derived from this data in src/keys.ts; no separate type generation.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { format, resolveConfig } from 'prettier';

import { CATALOG_ROOT, PACKAGE_ROOT, RESERVED_NAMESPACES, SEEDED_LOCALES } from './catalog.mjs';
import { SOURCE_LOCALE } from './gates.mjs';

export const RESOURCES_PATH = join(PACKAGE_ROOT, 'src', 'generated', 'resources.ts');

function readMergedCatalog(locale) {
  return Object.fromEntries(
    RESERVED_NAMESPACES.map((namespace) => [
      namespace,
      JSON.parse(readFileSync(join(CATALOG_ROOT, namespace, `${locale}.json`), 'utf8')),
    ]),
  );
}

export async function renderResources() {
  const source = { translation: readMergedCatalog(SOURCE_LOCALE) };
  const locales = SEEDED_LOCALES.map((locale) => {
    const data =
      locale === SOURCE_LOCALE
        ? 'source'
        : JSON.stringify({ translation: readMergedCatalog(locale) });
    return `${JSON.stringify(locale)}: ${data}`;
  });
  const output = `// AUTO-GENERATED from catalogs; edit the JSON files, then run:
// pnpm --filter @bolusi/i18n i18n:gen

const source = ${JSON.stringify(source)};

// Every locale must match the source catalog's shape; values remain ordinary strings.
export const resources = {
  ${locales.join(',\n')}
} satisfies Record<${SEEDED_LOCALES.map((locale) => JSON.stringify(locale)).join(' | ')}, typeof source>;
`;
  return format(output, { ...(await resolveConfig(RESOURCES_PATH)), filepath: RESOURCES_PATH });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  mkdirSync(dirname(RESOURCES_PATH), { recursive: true });
  writeFileSync(RESOURCES_PATH, await renderResources());
  console.log('i18n:gen: wrote src/generated/resources.ts');
}
