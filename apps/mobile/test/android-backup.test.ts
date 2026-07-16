// SEC-DEV-08 — Android auto-backup must not carry this app's data off the device
// (security-guide §6.2:194, §7 table; api/02-auth §7.4 "a device identity is never resurrected").
//
// SEC-DEV-08 IS SCOPED TO THE BUILD ARTIFACT, DELIBERATELY. Its security-guide row claims what this
// file can actually prove — that the SHIPPED manifest carries the exclusion — and claims nothing
// about a real restore. That narrowness is the point: a verbatim-id title RETIRES an id (task 31),
// so an id defined as "a restored backup yields no usable identity" would be marked shipped by a
// config assertion that has never seen a device. The on-device restore leg is NOT covered by this
// id and is not implied by it; it is named as residual risk below and reported, not papered over.
//
// WHY THIS SUITE COMPILES THE MODS INSTEAD OF READING `app.config.ts` (the whole point — T-14d).
// `app.config.ts` is the source that *hopes*; `AndroidManifest.xml` is the artifact that *ships*.
// Asserting on `app.config.ts` would only prove this file can read its own repo — and it would have
// been GREEN throughout the entire period this control was believed missing. The repo greps clean
// for `allowBackup`/`data-extraction-rules` (that grep is what filed task 58) and yet the GENERATED
// manifest already carries `android:dataExtractionRules`, because `expo-secure-store`'s config
// plugin injects it with `configureAndroidBackup` defaulting to `true`. Source-level greps and
// artifact-level truth disagree here, so this suite runs the REAL plugin chain — every plugin in
// `app.config.ts`, in order — over a template manifest and asserts on what comes out.
//
// It also RESOLVES the `@xml/...` resource reference to the file on disk and asserts that file's
// contents. That is deliberate (T-14 — a guard must assert its own coverage): the exclusion is
// currently owned by expo-secure-store's own Android resource, so if upstream renames the resource,
// renames its SharedPreferences file, or drops the rules, a guard that only checked the manifest
// attribute would stay green while the protection vanished.
//
// WHAT THIS SUITE CANNOT ANSWER (D12/D13 — there is no physical Android on this project):
// that a real Google Drive restore or a real device-to-device transfer honours these rules. It
// proves the exclusion is present in the shipped manifest and that the rules say what they must.
// The on-device behaviour is unverified. No assertion here may be read as a device-verified restore.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { beforeAll, describe, expect, test } from 'vitest';

// `createRequire` on purpose: these are CJS build tools that must load exactly as the real prebuild
// loads them, not through vitest's module graph (which aliases `react-native` to a double).
const require = createRequire(import.meta.url);
const MOBILE_ROOT = join(dirname(new URL(import.meta.url).pathname), '..');

/** The domains a backup rule may `<include>` and still leave `bolusi.db` on the device. */
const DB_FREE_INCLUDE_DOMAINS = new Set(['sharedpref']);

/** expo-secure-store's SharedPreferences file — the entry that must never leave the device. */
const SECURE_STORE_PREFS = 'SecureStore';

interface Rule {
  readonly domain: string;
  readonly path: string;
}
interface RuleSet {
  readonly includes: readonly Rule[];
  readonly excludes: readonly Rule[];
}

let manifestXml: string;
let application: Record<string, string>;

/**
 * Build a template android project, run the real prebuild pipeline over it, and return the
 * generated manifest — i.e. what `expo prebuild` would write.
 *
 * `getPrebuildConfigAsync` (NOT `getConfig`) is what makes this faithful, and the difference is not
 * academic — it is the bug this harness itself shipped for one iteration. `getConfig` applies only
 * the `plugins` array; every core `app.config.ts` → manifest mapping (`allowBackup`, permissions,
 * orientation, package …) lives in `withAndroidExpoPlugins` inside `@expo/prebuild-config`, which
 * only `getPrebuildConfigAsync` pulls in. Under `getConfig` this suite read a manifest with NO
 * `android:allowBackup` no matter what `app.config.ts` said — an assertion that could never pass and,
 * worse, a whole class of settings that would have silently read as absent. The tell was an
 * assertion that stayed red after a correct fix; nothing else would have surfaced it.
 *
 * `@expo/prebuild-config` is resolved THROUGH expo → @expo/cli rather than declared as a
 * devDependency on purpose: this must be the exact copy the real `expo prebuild` loads. A separately
 * installed copy could drift to a different version and this suite would then assert against a
 * pipeline the app never runs — a real number with fictional provenance (§2.1).
 */
async function compileAndroidManifest(): Promise<string> {
  const expoRequire = createRequire(require.resolve('expo/package.json'));
  const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
  const { getPrebuildConfigAsync } = cliRequire('@expo/prebuild-config') as {
    getPrebuildConfigAsync: (
      projectRoot: string,
      props: Record<string, unknown>,
    ) => Promise<{ exp: { plugins?: unknown[]; android?: { allowBackup?: boolean } } }>;
  };
  const { compileModsAsync } = require('expo/config-plugins') as {
    compileModsAsync: (config: unknown, opts: Record<string, unknown>) => Promise<unknown>;
  };

  const projectRoot = mkdtempSync(join(tmpdir(), 'bolusi-prebuild-'));
  const manifestPath = join(projectRoot, 'android/app/src/main/AndroidManifest.xml');

  // The bare-minimum template's shape. `singleTask` matches the real template so the scheme mod
  // does not warn; the rest exist because other plugins in the chain read them.
  const template: Record<string, string> = {
    'android/app/src/main/AndroidManifest.xml': `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:name=".MainApplication" android:label="@string/app_name">
    <activity android:name=".MainActivity" android:exported="true" android:launchMode="singleTask"/>
  </application>
</manifest>`,
    // The package-rename mod reads these off disk; they carry the config's `android.package`.
    'android/app/src/main/java/com/bolusi/app/MainApplication.kt':
      'package com.bolusi.app\nclass MainApplication\n',
    'android/app/src/main/java/com/bolusi/app/MainActivity.kt':
      'package com.bolusi.app\nclass MainActivity\n',
    'android/app/proguard-rules.pro': '# template\n',
    'android/gradle.properties': 'android.useAndroidX=true\n',
    'android/build.gradle': 'buildscript { ext { minSdkVersion = 24 } }\n',
    'android/app/build.gradle':
      "android { namespace 'com.bolusi.app'\n defaultConfig { applicationId 'com.bolusi.app' } }\n",
    'android/settings.gradle': "rootProject.name = 'bolusi'\n",
    'android/app/src/main/res/values/strings.xml':
      '<resources><string name="app_name">Bolusi</string></resources>',
    'android/app/src/main/res/values/styles.xml': '<resources></resources>',
    'android/app/src/main/res/values/colors.xml': '<resources></resources>',
  };
  for (const [rel, body] of Object.entries(template)) {
    const abs = join(projectRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }

  const { exp } = await getPrebuildConfigAsync(MOBILE_ROOT, { platforms: ['android'] });

  // Guard the guard: if the plugin list this compiles is not the app's real one, every assertion
  // below is theatre. Fail loudly rather than assert against an empty chain (T-14). Entries are
  // either `'name'` or `['name', opts]`, so normalise before looking.
  const pluginNames = (exp.plugins ?? []).map((entry) =>
    typeof entry === 'string' ? entry : Array.isArray(entry) ? String(entry[0]) : '',
  );
  expect(pluginNames, 'the compiled config must carry app.config.ts plugins').toContain(
    'expo-secure-store',
  );

  await compileModsAsync(exp, {
    projectRoot,
    platforms: ['android'],
    assertMissingModProviders: false,
  });
  return readFileSync(manifestPath, 'utf8');
}

/** Pull `<application …>`'s attributes out of the generated manifest. */
function readApplicationAttributes(xml: string): Record<string, string> {
  const tag = /<application\b([^>]*)>/.exec(xml);
  if (tag?.[1] === undefined) throw new Error('generated manifest has no <application> element');
  const attrs: Record<string, string> = {};
  for (const m of tag[1].matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) {
    const [, name, value] = m;
    if (name !== undefined && value !== undefined) attrs[name] = value;
  }
  return attrs;
}

/**
 * Resolve an `@xml/name` manifest reference to the real file backing it, searching the app's own
 * res/ first and then each declared dependency's Android res/ (expo-secure-store ships the rules as
 * a library resource). Throws if nothing provides it — an unresolvable reference is a red guard,
 * never a skipped one.
 */
function resolveXmlResource(reference: string): string {
  const name = /^@xml\/(.+)$/.exec(reference)?.[1];
  if (name === undefined) throw new Error(`not an @xml resource reference: ${reference}`);

  const pkg = JSON.parse(readFileSync(join(MOBILE_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const roots = Object.keys(pkg.dependencies ?? {}).flatMap((dep) => {
    try {
      return [join(dirname(require.resolve(`${dep}/package.json`)), 'android/src/main/res/xml')];
    } catch {
      return [];
    }
  });
  roots.unshift(join(MOBILE_ROOT, 'android/app/src/main/res/xml'));

  for (const root of roots) {
    try {
      return readFileSync(join(root, `${name}.xml`), 'utf8');
    } catch {
      /* next candidate */
    }
  }
  throw new Error(`no file on disk provides the manifest's ${reference} reference`);
}

/** Parse `<include>`/`<exclude>` rules out of an XML fragment. */
function parseRules(fragment: string): RuleSet {
  const collect = (kind: 'include' | 'exclude'): Rule[] =>
    [...fragment.matchAll(new RegExp(`<${kind}\\b([^>]*)/?>`, 'g'))].map((m) => ({
      domain: /domain\s*=\s*"([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '',
      path: /path\s*=\s*"([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '',
    }));
  return { includes: collect('include'), excludes: collect('exclude') };
}

/** Isolate a named child section (`<cloud-backup>…`) of the data-extraction rules. */
function section(xml: string, name: string): string {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  if (found?.[1] === undefined) {
    throw new Error(`data-extraction-rules is missing its <${name}> section`);
  }
  return found[1];
}

/**
 * The two properties §6.2:194 actually requires of a rule set, asserted against Android's real
 * semantics rather than against the shape of the file we happen to ship.
 */
function expectExcludesAppData(rules: RuleSet, label: string): void {
  // 1. SecureStore's prefs (device_private_key, device_token, db_encryption_key) never leave.
  expect(
    rules.excludes,
    `${label} must exclude expo-secure-store's SharedPreferences (security-guide §6.2)`,
  ).toContainEqual({ domain: 'sharedpref', path: SECURE_STORE_PREFS });

  // 2. The SQLCipher DB never leaves. Android: "If you specify an <include> element, the system no
  //    longer includes any files by default and backs up only the files specified." So an include
  //    list restricted to `sharedpref` is what keeps `bolusi.db` (file/database domain) off the
  //    backup — and an EMPTY include list would silently back up everything, which is why the
  //    non-empty assertion is here and not a stylistic nicety.
  expect(
    rules.includes.length,
    `${label} must <include> something — an empty include list backs up ALL app data, SQLCipher DB included`,
  ).toBeGreaterThan(0);
  for (const rule of rules.includes) {
    expect(
      DB_FREE_INCLUDE_DOMAINS.has(rule.domain),
      `${label} includes domain "${rule.domain}" (path "${rule.path}"), which can carry the SQLCipher DB (bolusi.db) into a backup — security-guide §6.2:194 requires the DB be excluded`,
    ).toBe(true);
  }
}

beforeAll(async () => {
  manifestXml = await compileAndroidManifest();
  application = readApplicationAttributes(manifestXml);
}, 120_000);

describe('SEC-DEV-08: the generated AndroidManifest excludes app data from backup', () => {
  test('cloud backup is disabled outright (android:allowBackup="false")', () => {
    // The belt to the rules' braces. Android's default is `true`, and it is a manifest-level
    // default: nothing in this repo has ever set it, so every build so far shipped allowBackup=true.
    expect(application['android:allowBackup']).toBe('false');
  });

  test('Android 12+ (dataExtractionRules) excludes SecureStore and the SQLCipher DB from BOTH cloud backup and device transfer', () => {
    const reference = application['android:dataExtractionRules'];
    expect(
      reference,
      'the manifest must point at data-extraction rules (Android 12+)',
    ).toBeDefined();

    const xml = resolveXmlResource(reference ?? '');

    // Both sections, not one. `allowBackup=false` does NOT disable device-to-device transfer on
    // Android 12+ ("On devices from some device manufacturers, specifying android:allowBackup=false
    // disables cloud-based backup and restore … but doesn't disable device-to-device transfers"),
    // and a MISSING section is fully enabled, not off. A franchise hand-me-down is a device
    // transfer, not a cloud restore — this is the likelier path for this fleet, not the tail.
    expectExcludesAppData(parseRules(section(xml, 'cloud-backup')), 'cloud-backup');
    expectExcludesAppData(parseRules(section(xml, 'device-transfer')), 'device-transfer');
  });

  test('Android 11 and lower (fullBackupContent) excludes SecureStore and the SQLCipher DB', () => {
    // Not the tail: the fleet is cheap Android, so old API levels are the normal case.
    const reference = application['android:fullBackupContent'];
    expect(
      reference,
      'the manifest must point at backup rules (Android 11 and lower)',
    ).toBeDefined();

    const xml = resolveXmlResource(reference ?? '');
    expectExcludesAppData(parseRules(xml), 'full-backup-content');
  });
});
