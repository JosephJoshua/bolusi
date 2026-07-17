// The iOS config guard — tasks 83 (bundle identity) + 87 (usage descriptions), under D17/D18 §3
// (iOS is a first-class, co-equal target). Sibling to test/android-backup.test.ts; same discipline:
// assert the GENERATED artifact (what `expo prebuild` produces), never `app.config.ts` (the source
// that hopes). Asserting the source proves only that the file can read itself, and it would have
// been green throughout the entire period these defects existed.
//
// ── WHY THIS ASSERTS THE COMPILED Info.plist, AND HOW (introspection) ──────────────────────────
// Info.plist usage descriptions are NOT the static `ios.infoPlist` field (that is `null` here). They
// are produced by config-plugin MODS during prebuild — and `expo-location`/`expo-camera` are applied
// by Expo AUTOLINKING (getPrebuildConfig.js → withLegacyExpoPlugins, gated on the real autolinked
// module list) even when absent from `app.config.ts`'s `plugins`. Task 80 read the static
// `ios.infoPlist` (null) and the explicit `plugins` list, and concluded the keys were ABSENT — a
// source-vs-artifact miss (T-16: produce the artifact, don't grep). Producing the artifact shows the
// keys are PRESENT, shipped by autolinking with the library's ENGLISH DEFAULT strings.
//
// We compile the mods via `compileModsAsync(..., { introspect: true })` — Expo's own
// `expo config --type introspect` path. A real-file compile (`introspect: false`) cannot run
// headlessly: the `ios.dangerous` base mod throws `Could not locate a valid AppDelegate` without a
// full Xcode project (AppDelegate + .pbxproj + Podfile), which cannot be faithfully templated here.
// Introspection strips those non-introspective mods and runs the IDENTICAL permission mods
// (`IOSConfig.Permissions.applyPermissions`, via `withInfoPlist`) over an in-memory base plist, so
// the resulting usage-description keys are exactly what real prebuild writes. That is the boundary of
// this suite's fidelity, stated rather than hidden: it verifies the Info.plist KEYS the permission
// plugins emit; it does not stand up a full iOS project.
//
// ── WHY ASSERT THE DELIBERATE STRING, NOT MERE PRESENCE (the load-bearing choice, T-14/§2.11) ──
// Because autolinking supplies NSLocationWhenInUseUsageDescription with the English default EVEN WHEN
// the plugin is unregistered, a guard that checked mere PRESENCE would stay GREEN after someone
// removed the explicit registration — green for the wrong reason. Asserting the exact Indonesian copy
// is what makes "unregister expo-location" go RED (the key reverts to the English default). Likewise
// the app requests only FOREGROUND location and captures PHOTOS ONLY, so this suite asserts the
// over-declared keys the autolinked defaults ship (NSLocationAlways*, NSMotion*, NSMicrophone*) are
// ABSENT — re-enabling any of them (an App Store rejection risk) goes RED.
//
// ── WHAT THIS SUITE CANNOT ANSWER (D12/D13 as amended by D17 §3 — no iOS target of ANY kind) ────
// There is no physical iPhone, no macOS host, no Xcode, and no Simulator on this infrastructure (all
// CI is ubuntu-latest; task 85 is the infra gap). Everything here is verified in the GENERATED iOS
// artifact; that iOS at runtime honours the bundle identifier, shows these strings in its system
// permission dialogs, or scopes the Keychain accordingly is UNVERIFIED on a real iPhone, and was not
// attempted on a Simulator because none can run in this environment. No green here is a device test.
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { beforeAll, describe, expect, test } from 'vitest';

// `createRequire` on purpose: these are CJS build tools that must load exactly as real prebuild loads
// them (through `expo` → `@expo/cli`), not through vitest's module graph.
const require = createRequire(import.meta.url);
const MOBILE_ROOT = join(dirname(new URL(import.meta.url).pathname), '..');

/** The placeholder `@expo/prebuild-config` synthesizes when no `ios.bundleIdentifier` is set. */
const PLACEHOLDER_BUNDLE_ID = 'com.placeholder.appid';
/** The owner-chosen iOS identity (task 83; mirrors `android.package`). */
const EXPECTED_BUNDLE_ID = 'com.bolusi.app';

/**
 * The app's native modules that request a protected iOS resource, mapped to the usage-description
 * keys each REQUIRES and the exact (Indonesian-first, deliberate) string the generated Info.plist
 * must carry. This is the guard's DENOMINATOR (T-14): every module here that is also a dependency is
 * checked, and an empty intersection is a RED, never a skipped, guard. When task 82 wires capture it
 * inherits the `expo-camera` row for free; a future native dep that needs a usage description is
 * added here in the same commit that adds the dep.
 */
const REQUIRED_IOS_USAGE_DESCRIPTIONS: Record<string, Readonly<Record<string, string>>> = {
  // Foreground only — `ports/location.ts` calls `requestForegroundPermissionsAsync`, never `Always`.
  'expo-location': {
    NSLocationWhenInUseUsageDescription:
      'Izinkan aplikasi memakai lokasi untuk mencatat tempat pekerjaan dilakukan.',
  },
  // Photos only (06-media-pipeline; `media.permission.camera` = "ambil foto"). Microphone disabled.
  'expo-camera': {
    NSCameraUsageDescription: 'Izinkan aplikasi memakai kamera untuk ambil foto.',
  },
};

/**
 * Usage descriptions the autolinked plugin DEFAULTS would ship but the app does NOT request, so they
 * must be absent from the generated artifact (each set `false` in `app.config.ts`). Declaring an
 * unused permission string is an App Store rejection risk — this is the over-declaration half of the
 * guard.
 */
const MUST_BE_ABSENT: readonly string[] = [
  'NSLocationAlwaysAndWhenInUseUsageDescription',
  'NSLocationAlwaysUsageDescription',
  'NSMotionUsageDescription',
  'NSMicrophoneUsageDescription',
];

/** The library English defaults — a shipped usage description must never equal one of these. */
const ENGLISH_DEFAULTS: readonly string[] = [
  'Allow $(PRODUCT_NAME) to access your location',
  'Allow $(PRODUCT_NAME) to access your camera',
  'Allow $(PRODUCT_NAME) to access your microphone',
  'Allow $(PRODUCT_NAME) to detect your current motion activity',
];

interface PrebuildExp {
  readonly ios?: {
    readonly bundleIdentifier?: string;
    readonly infoPlist?: Record<string, unknown>;
  };
  readonly plugins?: readonly unknown[];
}

let exp: PrebuildExp;
let infoPlist: Record<string, unknown>;

/**
 * Load the REAL prebuild config for iOS and compile its mods in introspection mode.
 *
 * `getPrebuildConfigAsync` (NOT `getConfig`) is what makes this faithful — it applies the core
 * `app.config.ts` → native mapping AND the autolinked config plugins, exactly like `expo prebuild`.
 * `@expo/prebuild-config` is resolved THROUGH `expo` → `@expo/cli` so it is the exact copy real
 * prebuild loads, not a devDependency that could drift (task 58's own §Outcome documents why).
 */
async function loadIosArtifact(): Promise<{
  exp: PrebuildExp;
  infoPlist: Record<string, unknown>;
}> {
  const expoRequire = createRequire(require.resolve('expo/package.json'));
  const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
  const { getPrebuildConfigAsync } = cliRequire('@expo/prebuild-config') as {
    getPrebuildConfigAsync: (
      projectRoot: string,
      props: Record<string, unknown>,
    ) => Promise<{ exp: PrebuildExp }>;
  };
  const { compileModsAsync } = expoRequire('expo/config-plugins') as {
    compileModsAsync: (
      config: unknown,
      opts: Record<string, unknown>,
    ) => Promise<{ ios?: { infoPlist?: Record<string, unknown> } }>;
  };

  const { exp: resolved } = await getPrebuildConfigAsync(MOBILE_ROOT, { platforms: ['ios'] });
  const projectRoot = mkdtempSync(join(tmpdir(), 'bolusi-ios-config-'));
  const compiled = await compileModsAsync(resolved, {
    projectRoot,
    platforms: ['ios'],
    introspect: true,
  });
  return { exp: resolved, infoPlist: compiled.ios?.infoPlist ?? {} };
}

beforeAll(async () => {
  ({ exp, infoPlist } = await loadIosArtifact());
}, 120_000);

describe('iOS bundle identity (task 83): the generated config carries a real bundle id, not the placeholder', () => {
  test('the resolved iOS bundle identifier is the owner-chosen id', () => {
    expect(exp.ios?.bundleIdentifier).toBe(EXPECTED_BUNDLE_ID);
  });

  test('the resolved iOS bundle identifier is NOT the silent Expo placeholder', () => {
    // The bug is not "absent" — it is "a plausible, wrong, SHARED id". A presence-only check would
    // pass against the placeholder, so the placeholder is named and refused explicitly.
    expect(exp.ios?.bundleIdentifier).not.toBe(PLACEHOLDER_BUNDLE_ID);
  });
});

describe('iOS usage descriptions (task 87): the generated Info.plist carries deliberate copy for what the app requests, and nothing it does not', () => {
  test('every native module that requests a protected resource has its usage description present and DELIBERATE (not the English default)', () => {
    const pkg = JSON.parse(readFileSync(join(MOBILE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});

    // The denominator (T-14): the modules actually installed AND known to need a usage description.
    // A starved enumeration must be RED, never a green that silently checked nothing.
    const coveredModules = Object.keys(REQUIRED_IOS_USAGE_DESCRIPTIONS).filter((m) =>
      deps.includes(m),
    );
    expect(
      coveredModules.length,
      'no known usage-description-requiring native module is a dependency — the guard is checking nothing (T-14 starved denominator)',
    ).toBeGreaterThan(0);

    for (const moduleId of coveredModules) {
      for (const [key, expected] of Object.entries(
        REQUIRED_IOS_USAGE_DESCRIPTIONS[moduleId] ?? {},
      )) {
        // Present at all.
        expect(
          infoPlist[key],
          `${moduleId} requires ${key} in the generated Info.plist (Root/ports request the resource; iOS terminates on access with no description)`,
        ).toBeDefined();
        // And it is OUR string, not the autolinked English default — this is the assertion that
        // goes RED when the plugin is unregistered (autolinking would still supply the default).
        expect(
          infoPlist[key],
          `${key} must carry the deliberate Indonesian copy, not the library English default (unregister → reverts to default → this is where it must fail)`,
        ).toBe(expected);
      }
    }
  });

  test('permissions the app does NOT request are absent (over-declaration is an App Store rejection risk)', () => {
    for (const key of MUST_BE_ABSENT) {
      expect(
        infoPlist[key],
        `${key} is declared but the app never requests it — set it \`false\` in app.config.ts (autolinked default re-adds it otherwise)`,
      ).toBeUndefined();
    }
  });

  test('no shipped usage description is a library English default', () => {
    for (const [key, value] of Object.entries(infoPlist)) {
      if (!key.endsWith('UsageDescription')) continue;
      // expo-dev-client / expo-secure-store contribute dev-only + FaceID strings that this task does
      // not own; scope this sweep to the keys the app deliberately configures.
      if (!Object.values(REQUIRED_IOS_USAGE_DESCRIPTIONS).some((m) => key in m)) continue;
      expect(
        ENGLISH_DEFAULTS,
        `${key} still carries a library English default on an Indonesian-first product`,
      ).not.toContain(value);
    }
  });
});
