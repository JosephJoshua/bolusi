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
const SERVER_PID = path.join(STATE, 'server.pid');
const READY_PREFIX = 'BOLUSI_LANE_READY: ';
const APP_ID = 'com.bolusi.app';
const AVD = 'bolusi-qa';
const SIM = 'bolusi-qa';
const PORT = 3000;

const ANDROID_HOME =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  path.join(homedir(), 'Library/Android/sdk');
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

async function startServer() {
  if (existsSync(SERVER_PID)) stopServer();
  mkdirSync(STATE, { recursive: true });
  const log = openSync(SERVER_LOG, 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/harness-serve-lane.mjs')], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  writeFileSync(SERVER_PID, String(child.pid));
  for (let waited = 0; waited < 120_000; waited += 500) {
    const line = readFileSync(SERVER_LOG, 'utf8')
      .split('\n')
      .find((l) => l.startsWith(READY_PREFIX));
    if (line) return JSON.parse(line.slice(READY_PREFIX.length));
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  throw new Error(`lane server did not become ready; see ${SERVER_LOG}`);
}

function stopServer() {
  if (!existsSync(SERVER_PID)) return;
  try {
    process.kill(-Number(readFileSync(SERVER_PID, 'utf8')), 'SIGTERM');
  } catch {
    // already gone
  }
  rmSync(SERVER_PID);
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
      ['-avd', AVD, '-no-window', '-no-audio', '-no-boot-anim', '-memory', '2048'],
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

  const apk = path.join(MOBILE, 'android/app/build/outputs/apk/release/app-release.apk');
  if (build || !existsSync(apk)) {
    const buildEnv = { ...env, EXPO_PUBLIC_API_URL: `http://10.0.2.2:${PORT}` };
    run('pnpm', ['exec', 'expo', 'prebuild', '--platform', 'android', '--no-install'], {
      cwd: MOBILE,
      env: buildEnv,
    });
    run('./gradlew', ['assembleRelease'], { cwd: path.join(MOBILE, 'android'), env: buildEnv });
  }
  // The lane server starts empty each time, so start the app from a clean install too.
  try {
    run('adb', ['uninstall', APP_ID]);
  } catch {
    // not installed yet
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
    const buildEnv = { ...env, EXPO_PUBLIC_API_URL: `http://127.0.0.1:${PORT}` };
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
    writeFileSync(file, execFileSync('adb', ['exec-out', 'screencap', '-p'], { env }));
  } else {
    run('xcrun', ['simctl', 'io', simUdid(), 'screenshot', file]);
  }
  console.log(file);
}

function down() {
  stopServer();
  try {
    run('adb', ['emu', 'kill']);
  } catch {
    // no emulator running
  }
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

  const build = !rest.includes('--no-build');
  if (build) run('pnpm', ['exec', 'tsc', '-b'], { cwd: ROOT });
  const ready = await startServer();
  await (platform === 'android' ? androidUp(build) : iosUp(build));
  console.log(`\nApp is up on ${platform}. Lane server: ${ready.url} (log ${SERVER_LOG})`);
  console.log(`Enrollment credentials: ${JSON.stringify(ready.credentials)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
