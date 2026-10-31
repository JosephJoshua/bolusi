# App updates

Every app updates itself in the background and switches to the new version only when
nobody is in the middle of something. Unsynced changes stay in the device database
through any update.

## Counter PC

electron-updater reads GitHub Releases (`desktop-v<version>` tags, `desktop-release`
workflow; steps in `development.md`). It checks a minute after start and every 4 hours
(30 minutes after a failure), downloads in the background, and installs on close, after
15 quiet minutes with no dialog open and no print running, or on "Pasang sekarang". The
core closes its database before the installer starts (`apps/desktop/src/main/update-policy.ts`).

## Phones

Two paths, chosen by what changed:

- **Over-the-air update** (JS, screens, rules, copy): push a tag `mobile-ota-<n>`. The
  `mobile-ota` workflow exports the bundle, signs one manifest per platform with the update
  key, and puts everything on a pre-release of that tag. Phones ask
  `GET <server>/updates/manifest` on every start; the server (`APP_UPDATES_REPO`) answers
  with the newest update made for that phone's native build. The phone checks the signature
  against `apps/mobile/updates/certificate.pem` and each file against its hash, downloads in
  the background and runs it from the next start, or right as someone returns after 30
  minutes away (`apps/mobile/src/bootstrap/app-updates.ts`).
- **Store release** (a new Expo SDK or native library): push a tag `mobile-v<version>`. The
  `mobile-play` workflow builds a signed app bundle and sends it to the Google Play closed
  testing track; Play installs it on store phones in the background. iPhones go through
  TestFlight or the App Store.

The runtime version is the native fingerprint (`fingerprint.config.js` leaves out the
version numbers), so an update only reaches phones whose native code it fits. Build store
releases and updates with the same `BOLUSI_API_URL`, or their fingerprints differ.

## Old and new versions together

Release the server before an app that sends a new change type or a new `schemaVersion`:
the server keeps every older version, so older apps keep syncing. A device that pulls a
change it cannot read stops pulling (pushing goes on, newer data from every device waits) and its sync status says to update
the app, with "Cek pembaruan" on phones (`APP_UPDATE_REQUIRED`, `docs/architecture.md`).

## One-time setup

- `BOLUSI_OTA_PRIVATE_KEY` secret: the PEM private key matching
  `apps/mobile/updates/certificate.pem`. Keep a copy offline; a lost key means a new
  certificate and a store release before updates flow again.
- Server: `APP_UPDATES_REPO=JosephJoshua/bolusi`.
- Google Play: a developer account, the app `com.bolusi.app` with its first bundle uploaded
  by hand, a closed testing track with the store phones' accounts, an upload keystore
  (`ANDROID_UPLOAD_KEYSTORE_BASE64`, `ANDROID_UPLOAD_STORE_PASSWORD`,
  `ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_KEY_PASSWORD`) and a service account allowed to
  release (`PLAY_SERVICE_ACCOUNT_JSON`).
