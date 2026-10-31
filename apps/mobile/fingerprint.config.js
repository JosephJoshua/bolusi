// What makes two builds "the same native app" for over-the-air updates (docs/app-updates.md).
// The store version and build number change on every Play release without changing native code,
// so they are left out: an update then reaches every phone whose native code it fits.
// The numbers are @expo/fingerprint's SourceSkips flags (not a dependency of this package).
const EXPO_CONFIG_VERSIONS = 1;
const PACKAGE_JSON_SCRIPTS_WITHOUT_RUN = 512;

/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  sourceSkips: EXPO_CONFIG_VERSIONS | PACKAGE_JSON_SCRIPTS_WITHOUT_RUN,
};
