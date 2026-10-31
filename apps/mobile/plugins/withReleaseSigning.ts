// Config plugin: release builds are signed with the Play upload key when the build is given one.
//
// The template signs release builds with the debug keystore, which Google Play refuses. The
// mobile-play workflow decodes the upload keystore from a secret and passes its path and passwords
// in BOLUSI_UPLOAD_* environment variables; without them (local and QA builds) nothing changes.
//
// No relative `.ts` imports, for the reason given in withHarnessActivity.ts.
import { withAppBuildGradle, type ConfigPlugin } from 'expo/config-plugins';

const UPLOAD = 'BOLUSI_UPLOAD_STORE_FILE';

const RELEASE_SIGNING = `
        release {
            if (System.getenv('${UPLOAD}')) {
                storeFile file(System.getenv('${UPLOAD}'))
                storePassword System.getenv('BOLUSI_UPLOAD_STORE_PASSWORD')
                keyAlias System.getenv('BOLUSI_UPLOAD_KEY_ALIAS')
                keyPassword System.getenv('BOLUSI_UPLOAD_KEY_PASSWORD')
            }
        }`;

const DEBUG_FOR_RELEASE = `            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;

/** Pure: add the upload signing config and use it for release builds when it is configured. */
export function applyReleaseSigning(gradle: string): string {
  if (gradle.includes(UPLOAD)) return gradle;
  const signingConfigs = 'signingConfigs {';
  if (!gradle.includes(signingConfigs) || !gradle.includes(DEBUG_FOR_RELEASE)) {
    throw new Error(
      'withReleaseSigning: app/build.gradle no longer has the expected signing blocks',
    );
  }
  return gradle.replace(signingConfigs, `${signingConfigs}${RELEASE_SIGNING}`).replace(
    DEBUG_FOR_RELEASE,
    `            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig System.getenv('${UPLOAD}') ? signingConfigs.release : signingConfigs.debug`,
  );
}

const withReleaseSigning: ConfigPlugin = (config) =>
  withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = applyReleaseSigning(mod.modResults.contents);
    return mod;
  });

export default withReleaseSigning;
