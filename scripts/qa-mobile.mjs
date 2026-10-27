#!/usr/bin/env node
// Brings the real native app up for interactive QA on a Mac: the lane server (PGlite, provisioned
// owner), a headless Android emulator or iOS Simulator, and a release build of the current checkout.
// The agent then drives the app with Maestro or a mobile MCP server and saves screenshots. See docs/qa.md.
//
//   pnpm qa:mobile up android|ios [--no-build]
//   pnpm qa:mobile shot android|ios <name>
//   pnpm qa:mobile down
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOBILE = path.join(ROOT, 'apps/mobile');
const STATE = path.join(ROOT, '.qa');
const SHOTS = path.join(ROOT, 'qa-artifacts');
const SERVER_LOG = path.join(STATE, 'server.log');
// Every request the app sends goes through scripts/qa-proxy.mjs and lands here (no bodies or tokens).
const REQUEST_LOG = path.join(STATE, 'requests.log');
const READY_PREFIX = 'BOLUSI_LANE_READY: ';
const APP_ID = 'com.bolusi.app';
const AVD = 'bolusi-qa';
const SIM = 'bolusi-qa';
const PORT = 3000;
const PROXY_PORT = 3091;
// One QA run per machine at a time, so threads sharing the QA VPS don't stack emulators.
const LOCK = path.join(homedir(), '.bolusi-qa.lock');
// Caps for a shared machine: one emulator with 4 cores and 4 GB, and a gentle build.
const EMULATOR_CORES = '4';
const EMULATOR_MEMORY_MB = '4096';
const GRADLE_WORKERS = '8';
// Prebuild's default 2 GB heap runs out in :app:compileReleaseArtProfile on a clean build.
const GRADLE_JVMARGS = '-Xmx4096m -XX:MaxMetaspaceSize=768m';

const ANDROID_HOME =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  path.join(homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
const STUDIO_JDK = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
const env = {
  ...process.env,
  ANDROID_HOME,
  JAVA_HOME: process.env.JAVA_HOME ?? (existsSync(STUDIO_JDK) ? STUDIO_JDK : undefined),
  PATH: [
    path.join(ANDROID_HOME, 'platform-tools'),
    path.join(ANDROID_HOME, 'emulator'),
    path.join(ANDROID_HOME, 'cmdline-tools/latest/bin'),
    path.join(homedir(), '.maestro/bin'),
    process.env.PATH,
  ].join(':'),
};

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', env, ...opts });
}

function out(cmd, args) {
  return execFileSync(cmd, args, { env, encoding: 'utf8' }).trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start a script as a detached background process logging to `log`; `stopProcess(name)` ends it. */
function startProcess(name, script, log, extraEnv = {}) {
  stopProcess(name);
  mkdirSync(STATE, { recursive: true });
  const out = openSync(log, 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script)], {
    cwd: ROOT,
    env: { ...env, ...extraEnv },
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  writeFileSync(path.join(STATE, `${name}.pid`), String(child.pid));
  return child;
}

function stopProcess(name) {
  const pidFile = path.join(STATE, `${name}.pid`);
  if (!existsSync(pidFile)) return;
  try {
    process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGTERM');
  } catch {
    // already gone
  }
  rmSync(pidFile);
}

async function startServer() {
  const child = startProcess('server', 'harness-serve-lane.mjs', SERVER_LOG);
  for (let waited = 0; waited < 120_000; waited += 500) {
    const line = readFileSync(SERVER_LOG, 'utf8')
      .split('\n')
      .find((l) => l.startsWith(READY_PREFIX));
    if (line) {
      startProcess('proxy', 'qa-proxy.mjs', REQUEST_LOG, {
        QA_PROXY_PORT: String(PROXY_PORT),
        QA_UPSTREAM_PORT: String(PORT),
      });
      return JSON.parse(line.slice(READY_PREFIX.length));
    }
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  throw new Error(`lane server did not become ready; see ${SERVER_LOG}`);
}

async function androidUp(build) {
  if (!out('emulator', ['-list-avds']).split('\n').includes(AVD)) {
    const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
    const image = `system-images;android-36;google_apis;${abi}`;
    run('sdkmanager', [image]);
    run('avdmanager', ['create', 'avd', '-n', AVD, '-k', image, '-d', 'pixel_6'], {
      input: 'no\n',
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  }
  if (!out('adb', ['devices']).includes('emulator-')) {
    const emu = spawn(
      'emulator',
      [
        '-avd',
        AVD,
        '-no-window',
        '-no-audio',
        '-no-boot-anim',
        '-gpu',
        'swiftshader_indirect',
        '-cores',
        EMULATOR_CORES,
        '-memory',
        EMULATOR_MEMORY_MB,
      ],
      {
        env,
        detached: true,
        stdio: 'ignore',
      },
    );
    emu.unref();
  }
  run('adb', ['wait-for-device']);
  while (out('adb', ['shell', 'getprop', 'sys.boot_completed']) !== '1') await sleep(2000);

  // The lane server starts empty each time, so start the app from a clean install too. Uninstall
  // before building: the previous run's app is still enrolled against the old database, and its
  // background sync would hit the new server with 401s during the build.
  try {
    run('adb', ['uninstall', APP_ID]);
  } catch {
    // not installed yet
  }

  const apk = path.join(MOBILE, 'android/app/build/outputs/apk/release/app-release.apk');
  if (build || !existsSync(apk)) {
    // A release build blocks cleartext HTTP; the harness flag (as in CI) allows it to 10.0.2.2 only.
    const buildEnv = {
      ...env,
      EXPO_PUBLIC_API_URL: `http://10.0.2.2:${PROXY_PORT}`,
      EXPO_PUBLIC_BOLUSI_TEST_HARNESS: '1',
    };
    run('pnpm', ['exec', 'expo', 'prebuild', '--platform', 'android', '--no-install'], {
      cwd: MOBILE,
      env: buildEnv,
    });
    run(
      './gradlew',
      [
        'assembleRelease',
        `--max-workers=${GRADLE_WORKERS}`,
        `-Dorg.gradle.jvmargs=${GRADLE_JVMARGS}`,
      ],
      {
        cwd: path.join(MOBILE, 'android'),
        env: buildEnv,
      },
    );
  }
  run('adb', ['install', apk]);
  run('adb', ['shell', 'monkey', '-p', APP_ID, '-c', 'android.intent.category.LAUNCHER', '1']);
}

function simUdid() {
  const devices = JSON.parse(
    out('xcrun', ['simctl', 'list', 'devices', 'available', '--json']),
  ).devices;
  return Object.values(devices)
    .flat()
    .find((d) => d.name === SIM)?.udid;
}

async function iosUp(build) {
  let udid = simUdid();
  if (!udid) {
    const types = JSON.parse(out('xcrun', ['simctl', 'list', 'devicetypes', '--json'])).devicetypes;
    const runtimes = JSON.parse(
      out('xcrun', ['simctl', 'list', 'runtimes', 'available', '--json']),
    ).runtimes;
    const type = types.filter((t) => /^iPhone \d+$/.test(t.name)).at(-1);
    const runtime = runtimes.filter((r) => r.platform === 'iOS').at(-1);
    udid = out('xcrun', ['simctl', 'create', SIM, type.identifier, runtime.identifier]);
  }
  try {
    run('xcrun', ['simctl', 'boot', udid]);
  } catch {
    // already booted
  }
  run('xcrun', ['simctl', 'bootstatus', udid, '-b']);

  const derived = path.join(STATE, 'ios-build');
  const findApp = () => {
    const products = path.join(derived, 'Build/Products/Release-iphonesimulator');
    if (!existsSync(products)) return undefined;
    const name = out('ls', [products])
      .split('\n')
      .find((f) => f.endsWith('.app'));
    return name && path.join(products, name);
  };
  if (build || !findApp()) {
    const buildEnv = { ...env, EXPO_PUBLIC_API_URL: `http://127.0.0.1:${PROXY_PORT}` };
    run('pnpm', ['exec', 'expo', 'prebuild', '--platform', 'ios', '--no-install'], {
      cwd: MOBILE,
      env: buildEnv,
    });
    run('pod', ['install'], { cwd: path.join(MOBILE, 'ios'), env: buildEnv });
    const workspace = out('ls', [path.join(MOBILE, 'ios')])
      .split('\n')
      .find((f) => f.endsWith('.xcworkspace'));
    run(
      'xcodebuild',
      [
        '-workspace',
        workspace,
        '-scheme',
        workspace.replace('.xcworkspace', ''),
        '-configuration',
        'Release',
        '-sdk',
        'iphonesimulator',
        '-destination',
        `id=${udid}`,
        '-derivedDataPath',
        derived,
        'CODE_SIGNING_ALLOWED=NO',
        'build',
      ],
      { cwd: path.join(MOBILE, 'ios'), env: buildEnv },
    );
  }
  try {
    run('xcrun', ['simctl', 'uninstall', udid, APP_ID]);
  } catch {
    // not installed yet
  }
  run('xcrun', ['simctl', 'install', udid, findApp()]);
  run('xcrun', ['simctl', 'launch', udid, APP_ID]);
}

function shot(platform, name) {
  mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${platform}-${name}.png`);
  if (platform === 'android') {
    writeFileSync(
      file,
      execFileSync('adb', ['exec-out', 'screencap', '-p'], { env, maxBuffer: 64 * 1024 * 1024 }),
    );
  } else {
    run('xcrun', ['simctl', 'io', simUdid(), 'screenshot', file]);
  }
  console.log(file);
}

function takeLock() {
  try {
    mkdirSync(LOCK);
  } catch {
    const owner = existsSync(path.join(LOCK, 'owner'))
      ? readFileSync(path.join(LOCK, 'owner'), 'utf8')
      : '?';
    throw new Error(
      `another QA run holds ${LOCK} (${owner.trim()}); wait for it or run qa:mobile down`,
    );
  }
  writeFileSync(path.join(LOCK, 'owner'), `${ROOT} since ${new Date().toISOString()}\n`);
}

function down() {
  rmSync(LOCK, { recursive: true, force: true });
  stopProcess('proxy');
  stopProcess('server');
  try {
    run('adb', ['emu', 'kill']);
  } catch {
    // no emulator running
  }
  if (process.platform !== 'darwin') return;
  try {
    run('xcrun', ['simctl', 'shutdown', 'all']);
  } catch {
    // no simulator running
  }
}

async function main() {
  const [command, platform, ...rest] = process.argv.slice(2);
  if (command === 'down') return down();
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error(
      'usage: qa:mobile up|shot android|ios [--no-build | <name>], or qa:mobile down',
    );
  }
  if (command === 'shot') return shot(platform, rest[0] ?? String(Date.now()));
  if (command !== 'up') throw new Error(`unknown command ${command}`);

  if (platform === 'ios' && process.platform !== 'darwin') throw new Error('iOS QA needs a Mac');
  takeLock();
  const build = !rest.includes('--no-build');
  if (build) run('pnpm', ['exec', 'tsc', '-b'], { cwd: ROOT });
  const ready = await startServer();
  await (platform === 'android' ? androidUp(build) : iosUp(build));
  console.log(`\nApp is up on ${platform}. Lane server: ${ready.url} (log ${SERVER_LOG})`);
  console.log(`App requests: ${REQUEST_LOG}`);
  console.log(`Enrollment credentials: ${JSON.stringify(ready.credentials)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
