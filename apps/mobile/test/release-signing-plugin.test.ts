// Google Play refuses a release signed with the debug key; the template signs releases with it.
import { describe, expect, test } from 'vitest';

import { applyReleaseSigning } from '../plugins/withReleaseSigning.js';

// The signing part of the template's app/build.gradle (Expo SDK 57), as prebuild writes it.
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}`;

describe('release signing', () => {
  const gradle = applyReleaseSigning(TEMPLATE);

  test('release builds use the upload key when the build is given one, else stay as before', () => {
    expect(gradle).toContain(
      "signingConfig System.getenv('BOLUSI_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug",
    );
    expect(gradle).toContain("storeFile file(System.getenv('BOLUSI_UPLOAD_STORE_FILE'))");
    expect(gradle).toContain("keyPassword System.getenv('BOLUSI_UPLOAD_KEY_PASSWORD')");
    // Debug builds keep the debug key.
    expect(gradle).toMatch(/debug \{\n {12}signingConfig signingConfigs\.debug/);
  });

  test('running twice changes nothing more', () => {
    expect(applyReleaseSigning(gradle)).toBe(gradle);
  });

  test('a template that moved its signing blocks fails the build instead of shipping debug-signed', () => {
    expect(() => applyReleaseSigning('android {}')).toThrow('withReleaseSigning');
  });
});
