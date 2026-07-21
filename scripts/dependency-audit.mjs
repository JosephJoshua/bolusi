// Dependency pin / lockfile audit (08-stack-and-repo §2; security-guide §11) — the sweep's
// supply-chain leg.
//
// It is NOT a duplicate of CI stage 1. Stage 1 runs `check-single-zod` and
// `check-forbidden-packages` over the lockfile; this adds the part neither covers: that the
// security-guide §11 LOAD-BEARING SET is pinned EXACT in the pnpm catalog at the exact versions the
// guide names. A caret would still satisfy both stage-1 checks while letting `canonicalize` — whose
// byte-identical output IS the op-hash preimage — drift on the next install.
//
// The expected versions below are transcribed from security-guide §11 and 08 §2.2–2.5. That
// transcription is itself checked: `EXPECTED_PINS` must cover every package the guide's §11 bullet
// names, so adding a package to the guide without adding it here fails rather than passes.
import { readFileSync } from 'node:fs';

/** security-guide §11, first bullet — the exact-pin set, verbatim. */
export const EXPECTED_PINS = {
  kysely: '0.29.3',
  '@hono/node-server': '2.0.8',
  canonicalize: '3.0.0',
  '@op-engineering/op-sqlite': '17.1.2',
  'react-native-quick-crypto': '1.1.6',
  hono: '4.12.30',
  zod: '4.4.3',
  '@hono/zod-validator': '0.8.0',
  '@noble/curves': '2.2.0',
  '@noble/hashes': '2.2.0',
  'kysely-generic-sqlite': '2.0.0',
};

/**
 * 08 §2.6 forbidden / not-installed packages, plus the v0 caution. `check-forbidden-packages.mjs`
 * owns the first four for CI stage 1; `react-native-reanimated` is cautioned rather than forbidden
 * there, and task 28's acceptance names it explicitly, so it is asserted here.
 */
export const FORBIDDEN_IN_LOCKFILE = [
  '@hono/node-ws',
  'expo-background-fetch',
  'kysely-expo',
  'expo-sqlite',
  'react-native-reanimated',
];

/**
 * Parse the `catalog:` block of pnpm-workspace.yaml into `name -> version` (quotes stripped).
 *
 * Line-walked rather than regex-blocked on purpose: the block is interleaved with `#` comments and
 * blank lines, and a `[\s\S]*?` block match that silently stops early would hand back a PARTIAL
 * catalog — every unparsed pin then reads as "not in the catalog", which is loud, but the inverse
 * (a truncated block that happens to contain the pins) would read as green.
 */
export function parseCatalog(workspaceYaml) {
  const catalog = {};
  let inBlock = false;
  for (const line of workspaceYaml.split('\n')) {
    if (/^catalog:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    // A new top-level key ends the block; blanks and comments do not.
    if (/^\S/.test(line)) break;
    const entry = line.match(/^\s+(['"]?)([^'":#]+)\1:\s*(\S+)\s*$/);
    if (entry === null) continue;
    catalog[entry[2].trim()] = entry[3].replace(/^['"]|['"]$/g, '');
  }
  return catalog;
}

/** The distinct resolved versions of `name` in a pnpm lockfile. */
export function lockfileVersions(lockfileText, name) {
  const escaped = name.replace(/[/@.\-]/g, '\\$&');
  const versions = new Set();
  for (const match of lockfileText.matchAll(
    new RegExp(`(?<![\\w.-])${escaped}@(\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?)`, 'g'),
  )) {
    versions.add(match[1]);
  }
  return [...versions].sort();
}

/**
 * @param {{ workspaceYaml: string, lockfileText: string, npmrcText: string, guideText: string }} input
 */
export function auditDependencies(input) {
  const failures = [];
  const catalog = parseCatalog(input.workspaceYaml);

  // Denominator (T-14): a catalog that parsed to nothing would make every pin check vacuous.
  if (Object.keys(catalog).length === 0) {
    failures.push('parsed ZERO entries from the pnpm-workspace.yaml `catalog:` block');
  }

  // (0) The transcription itself: every package named in §11's exact-pin bullet must appear in
  // EXPECTED_PINS, so a guide edit cannot leave this list quietly behind.
  const guideBullet = input.guideText.match(/\*\*Exact pins\*\*[^\n]*\n?/);
  if (guideBullet === null) {
    failures.push('could not locate the security-guide §11 "Exact pins" bullet to cross-check');
  } else {
    for (const match of guideBullet[0].matchAll(/`([^`@]+)@(\d[^`]*)`/g)) {
      const [, name, version] = match;
      if (EXPECTED_PINS[name] === undefined) {
        failures.push(
          `security-guide §11 pins ${name}@${version} but this audit does not check it — add it to EXPECTED_PINS`,
        );
      } else if (EXPECTED_PINS[name] !== version) {
        failures.push(
          `security-guide §11 says ${name}@${version}, this audit expects ${EXPECTED_PINS[name]} — the transcription drifted`,
        );
      }
    }
  }

  // (a) exact pins, no range operators, at the stated versions.
  for (const [name, version] of Object.entries(EXPECTED_PINS)) {
    const pinned = catalog[name];
    if (pinned === undefined) {
      failures.push(
        `${name} is not in the pnpm catalog — the load-bearing set is pinned there (08 §2.1)`,
      );
      continue;
    }
    if (/[\^~><*x|]|\s-\s/.test(pinned)) {
      failures.push(`${name} is pinned as "${pinned}" — a RANGE, not an exact version (08 §2.1.1)`);
      continue;
    }
    if (pinned !== version) {
      failures.push(
        `${name} is pinned at ${pinned}, security-guide §11 requires exactly ${version}`,
      );
    }
  }

  // (b) exactly one zod resolved.
  const zodVersions = lockfileVersions(input.lockfileText, 'zod');
  if (zodVersions.length !== 1) {
    failures.push(
      `pnpm-lock.yaml resolves ${zodVersions.length} zod versions (${zodVersions.join(', ') || 'none'}) — one zod only (08 §2.1.6)`,
    );
  }

  // (c) forbidden packages absent from the lockfile.
  for (const name of FORBIDDEN_IN_LOCKFILE) {
    const found = lockfileVersions(input.lockfileText, name);
    if (found.length > 0) {
      failures.push(
        `${name} is in pnpm-lock.yaml (${found.join(', ')}) — forbidden/cautioned by 08 §2.6`,
      );
    }
  }

  // (e) save-exact, so a future `pnpm add` cannot reintroduce a caret.
  if (!/^\s*save-exact\s*=\s*true\s*$/m.test(input.npmrcText)) {
    failures.push('.npmrc does not set `save-exact=true` (08 §2.1.1)');
  }

  return {
    ok: failures.length === 0,
    failures,
    checked: {
      catalogEntries: Object.keys(catalog).length,
      pinsChecked: Object.keys(EXPECTED_PINS).length,
      forbiddenChecked: FORBIDDEN_IN_LOCKFILE.length,
      zodVersions,
    },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = auditDependencies({
    workspaceYaml: readFileSync('pnpm-workspace.yaml', 'utf8'),
    lockfileText: readFileSync('pnpm-lock.yaml', 'utf8'),
    npmrcText: readFileSync('.npmrc', 'utf8'),
    guideText: readFileSync('ai-docs/security-guide.md', 'utf8'),
  });
  console.log(
    `dependency-audit: ${result.checked.catalogEntries} catalog entries, ` +
      `${result.checked.pinsChecked} load-bearing pins checked, ` +
      `${result.checked.forbiddenChecked} forbidden packages checked, ` +
      `zod resolved: ${result.checked.zodVersions.join(', ') || 'none'}.`,
  );
  for (const failure of result.failures) console.error(`dependency-audit: FAIL ${failure}`);
  process.exit(result.ok ? 0 : 1);
}
