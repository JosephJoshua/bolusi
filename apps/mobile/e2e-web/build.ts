/**
 * Every run exports the web bundle first, so no run ever checks a stale `dist/`: the workspace
 * packages (`tsc -b`, which skips what is current), then `expo export`. About ten seconds.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function build(): void {
  execFileSync('pnpm', ['run', 'build:web'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
