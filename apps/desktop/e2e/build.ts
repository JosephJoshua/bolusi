// Every run builds first, so no run ever drives a stale app: the workspace packages (`tsc -b`),
// then the app itself. Both skip what is already current, so a rerun costs a few seconds.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export default function build(): void {
  // The installed app in the Windows job is built and installed before the run.
  if (process.env['BOLUSI_E2E_EXECUTABLE'] !== undefined) return;
  const app = join(import.meta.dirname, '..');
  const run = (args: string[]) =>
    execFileSync('pnpm', args, { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' });
  run(['exec', 'tsc', '-b', '../..']);
  run(['run', 'build']);
}
