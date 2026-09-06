// The HarnessActivity config plugin (task 27a/175 deliverable #1). `apps/mobile/android/` is generated
// by prebuild and git-ignored, so the ONLY mechanism that can declare `HarnessActivity` in the manifest
// is this plugin. Its two pure pieces are unit-proven here (the full prebuild → generated-manifest grep
// is the falsification recorded in the PR); the dangerous-mod file write and the actual Kotlin COMPILE
// are the CI runner's job.
import { describe, expect, test } from 'vitest';

import withHarnessActivity, {
  HARNESS_ACTIVITY_NAME,
  HARNESS_CLEARTEXT_HOSTS,
  HARNESS_COMPONENT_NAME as PLUGIN_COMPONENT_NAME,
  HARNESS_NETWORK_SECURITY_CONFIG_RESOURCE,
  HARNESS_RUN_ID_EXTRA as PLUGIN_RUN_ID_EXTRA,
  addHarnessActivityToManifest,
  harnessActivityKotlin,
  harnessBuildEnabled,
  harnessNetworkSecurityConfigXml,
  setHarnessNetworkSecurityConfig,
} from '../plugins/withHarnessActivity.js';
import { HARNESS_COMPONENT_NAME, HARNESS_RUN_ID_EXTRA } from '../src/harness/contract.js';

/** A minimal manifest shaped like `@expo/config-plugins` hands the mod (one `<application>`). */
function fakeManifest(): {
  manifest: {
    application: Array<{
      $: Record<string, string>;
      activity?: Array<{ $: Record<string, string> }>;
    }>;
  };
} {
  return {
    manifest: {
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          activity: [{ $: { 'android:name': '.MainActivity' } }],
        },
      ],
    },
  };
}

describe('withHarnessActivity — manifest mod', () => {
  test('adds an exported `.HarnessActivity` with no intent-filter (explicit-component launch)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake matches the mod's shape
    const manifest = addHarnessActivityToManifest(fakeManifest() as any);
    const app = manifest.manifest.application?.[0];
    const harness = app?.activity?.find((a) => a.$['android:name'] === `.${HARNESS_ACTIVITY_NAME}`);
    expect(harness).toBeDefined();
    expect(harness?.$['android:exported']).toBe('true');
    // No intent-filter: the driver launches it by explicit component (`am start -n …/.HarnessActivity`),
    // and a LAUNCHER filter would put a test-only activity on the home screen.
    expect(harness).not.toHaveProperty('intent-filter');
    // MainActivity is left untouched.
    expect(app?.activity?.some((a) => a.$['android:name'] === '.MainActivity')).toBe(true);
  });

  test('is idempotent — a second application does not duplicate the activity', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake matches the mod's shape
    const once = addHarnessActivityToManifest(fakeManifest() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reuse the mutated manifest
    const twice = addHarnessActivityToManifest(once as any);
    const count = twice.manifest.application?.[0]?.activity?.filter(
      (a) => a.$['android:name'] === `.${HARNESS_ACTIVITY_NAME}`,
    ).length;
    expect(count).toBe(1);
  });
});

describe('withHarnessActivity — cleartext network security config (harness build only)', () => {
  const xml = harnessNetworkSecurityConfigXml();

  test('permits cleartext ONLY inside a domain-config, never the base-config', () => {
    // The carve-out lives in <domain-config cleartextTrafficPermitted="true">; the base-config is left to
    // the platform default (cleartext DENIED on API 28+). If the permit ever migrated to a base-config it
    // would open the whole harness app to cleartext — assert it never does.
    expect(xml).toContain('<domain-config cleartextTrafficPermitted="true">');
    expect(xml).not.toMatch(/<base-config[^>]*cleartextTrafficPermitted="true"/);
  });

  test('lists EXACTLY the two local test hosts — no third cleartext domain slips in', () => {
    // Every <domain> in the config, in file order.
    const domains = [...xml.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)].map((m) => m[1]);
    expect(domains).toEqual([...HARNESS_CLEARTEXT_HOSTS]);
    // The two we depend on are present…
    expect(domains).toContain('127.0.0.1'); // CHAOS nets via adb reverse
    expect(domains).toContain('10.0.2.2'); // emulator host alias (EXPO_PUBLIC_API_URL)
    // …and an arbitrary remote host is NOT — so cleartext to it stays denied by the default base-config.
    expect(domains).not.toContain('8.8.8.8');
    expect(xml).not.toContain('example.com');
  });

  test('the manifest mod points <application> at the harness @xml resource, idempotently', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake matches the mod's shape
    const once = setHarnessNetworkSecurityConfig(fakeManifest() as any);
    const attr = once.manifest.application?.[0]?.$['android:networkSecurityConfig'];
    expect(attr).toBe(`@xml/${HARNESS_NETWORK_SECURITY_CONFIG_RESOURCE}`);
    // A second pass writes the same value, not a duplicate/garbled attribute.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reuse the mutated manifest
    const twice = setHarnessNetworkSecurityConfig(once as any);
    expect(twice.manifest.application?.[0]?.$['android:networkSecurityConfig']).toBe(
      `@xml/${HARNESS_NETWORK_SECURITY_CONFIG_RESOURCE}`,
    );
  });
});

describe('withHarnessActivity — the build-time literals match the runtime contract (no drift)', () => {
  // The plugin is a build-time file and CANNOT import the runtime `.ts` (Expo's plugin transpile does
  // not extend to a nested relative import), so it duplicates the two wire literals. These assertions
  // are the guard that the duplication never drifts from `src/harness/contract.ts` — a drift boots the
  // activity to a blank screen (component name) or breaks the run-id echo (extra key), both §2.11 silent.
  test('the plugin component name equals contract.ts HARNESS_COMPONENT_NAME', () => {
    expect(PLUGIN_COMPONENT_NAME).toBe(HARNESS_COMPONENT_NAME);
  });
  test('the plugin run-id extra equals contract.ts HARNESS_RUN_ID_EXTRA', () => {
    expect(PLUGIN_RUN_ID_EXTRA).toBe(HARNESS_RUN_ID_EXTRA);
  });
});

describe('withHarnessActivity — generated Kotlin', () => {
  const kt = harnessActivityKotlin('com.bolusi.app');

  test('renders the harness JS component name that register.ts registers (contract, no drift)', () => {
    // The activity ↔ JS contract: getMainComponentName() MUST equal HARNESS_COMPONENT_NAME, or the
    // activity boots and AppRegistry finds no component (§2.11: silent blank screen).
    expect(kt).toContain(`getMainComponentName(): String = "${HARNESS_COMPONENT_NAME}"`);
  });

  test('forwards the run-id intent extra as initialProps, read LAZILY (task 177 runId round-trip fix)', () => {
    expect(kt).toContain('class HarnessActivity : ReactActivity()');
    // getLaunchOptions() must read the LIVE intent's extras at call time. RN invokes it from
    // ReactActivityDelegate.onCreate() (composeLaunchOptions()), AFTER the Activity is attached to its
    // launching intent. The previous code captured `val launchExtras = intent?.extras` inside
    // createReactActivityDelegate(), which ReactActivity calls from its CONSTRUCTOR — before the intent
    // is attached, so it froze null and the emitted result carried "runId":"" (task 175 hardware run).
    expect(kt).toContain(
      'override fun getLaunchOptions(): Bundle? = this@HarnessActivity.intent?.extras',
    );
    // REGRESSION GUARD (§2.11): the eager capture must NEVER come back. The bug was precisely a
    // `val launchExtras = intent?.extras` snapshot taken before the intent existed; assert that pattern
    // is gone so a future refactor cannot silently re-freeze null and re-empty the runId.
    expect(kt).not.toMatch(/val\s+launchExtras\s*=/);
    expect(kt).not.toContain('= launchExtras');
    // Names the exact extra key the driver passes (`--es bolusiHarnessRunId`), so the contract is visible.
    expect(kt).toContain(HARNESS_RUN_ID_EXTRA);
    expect(kt).toContain('package com.bolusi.app');
  });

  test('the entry-point name does NOT contain "Exception" (task 175 trap 2)', () => {
    // `amStartFailureReason`'s unanchored /Exception/ matches `am start`'s echoed component name; an
    // activity named *Exception* self-trips the driver's launch check with Status: ok.
    expect(HARNESS_ACTIVITY_NAME).not.toMatch(/Exception/);
    expect(kt).not.toMatch(/class \w*Exception\w* : ReactActivity/);
  });
});

describe('withHarnessActivity — flag gate', () => {
  const KEY = 'EXPO_PUBLIC_BOLUSI_TEST_HARNESS';

  test('is a no-op unless the harness flag is set at prebuild (no exported activity in prod/preview)', () => {
    const saved = process.env[KEY];
    try {
      delete process.env[KEY];
      expect(harnessBuildEnabled()).toBe(false);
      // With the flag off the plugin returns the config unchanged (identity) — no dangerous mod, no
      // manifest mod queued.
      const config = { name: 'Bolusi', slug: 'bolusi' } as Parameters<
        typeof withHarnessActivity
      >[0];
      expect(withHarnessActivity(config)).toBe(config);

      process.env[KEY] = '1';
      expect(harnessBuildEnabled()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });
});
