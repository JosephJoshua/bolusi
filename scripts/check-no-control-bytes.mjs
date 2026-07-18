// No-control-bytes-in-source guard (CLAUDE.md §2.9, task 45 F6).
//
// A composite-key builder that pastes a RAW NUL byte as its delimiter — instead of the `\x00` escape —
// turns a `.ts` SOURCE file into `data`: binary to git, so its diff renders as `Bin 4469 -> 8758 bytes`
// and the change to a security control becomes UNREVIEWABLE. Runtime behaviour is identical, so every
// test passes and no lint fires. Two independent agents reached for that construct in one wave (task 14
// `pin-verify.ts`, task 16 `poke-hub.ts`) — a class, not an accident. This guard closes it.
//
// It scans tracked TEXT-SOURCE files for any C0 control byte (0x00–0x1F) other than tab/newline/CR.
// The `\x00` ESCAPE — the four ASCII chars `\`, `x`, `0`, `0` — is fine and MUST pass, or the guard
// would ban the correct fix; a byte-level scan distinguishes the two by construction.
//
// `git ls-files` is the denominator, NOT a filesystem walk: sibling worktrees live inside the repo and
// a naive walk would sweep other branches' trees (the trap that made `pnpm lint` on main report peers'
// diagnostics). The scan reports how many files it read and FAILS on zero — a scanner that silently
// globs nothing is this repo's signature failure (T-14).
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Extensions treated as text source. A file with any of these extensions must be plain text; a control
 * byte in one is corruption (or the NUL-delimiter bug), never legitimate binary payload.
 */
export const TEXT_SOURCE_GLOBS = [
  '*.ts',
  '*.tsx',
  '*.js',
  '*.jsx',
  '*.mjs',
  '*.cjs',
  '*.json',
  '*.md',
  '*.yml',
  '*.yaml',
  '*.sql',
  '*.sh',
  '*.css',
  '*.html',
  '*.txt',
];

/**
 * Files exempt from the scan, exactly. Keep this tiny — every entry is a hole. An entry needs a reason
 * a reviewer can check (e.g. a file whose JOB is to hold a control byte, such as this guard's own test).
 */
export const EXEMPT_PATHS = new Set([]);

/** True for a C0 control byte that must never appear raw in source: 0x00–0x1F except tab/LF/CR. */
function isForbiddenControlByte(byte) {
  if (byte > 0x1f) return false;
  return byte !== 0x09 && byte !== 0x0a && byte !== 0x0d; // allow \t, \n, \r
}

/**
 * Scan file bytes for forbidden C0 control bytes.
 * @param {{ path: string, bytes: Uint8Array }[]} files
 * @returns {{ path: string, line: number, column: number, byte: number }[]}
 */
export function findControlBytes(files) {
  const findings = [];
  for (const { path, bytes } of files) {
    if (EXEMPT_PATHS.has(path)) continue;
    let line = 1;
    let column = 1;
    for (let i = 0; i < bytes.length; i += 1) {
      const byte = bytes[i];
      if (isForbiddenControlByte(byte)) {
        findings.push({ path, line, column, byte });
      }
      if (byte === 0x0a) {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
  }
  return findings;
}

/**
 * Tracked text-source files, read as raw bytes — `git ls-files` keeps the walk inside THIS worktree's
 * tree (not a filesystem walk that would cross into sibling worktrees).
 * @param {string} repoRoot
 * @returns {{ path: string, bytes: Uint8Array }[]}
 */
export function collectSourceFiles(repoRoot) {
  const result = spawnSync('git', ['ls-files', '-z', '--', ...TEXT_SOURCE_GLOBS], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((path) => existsSync(`${repoRoot}/${path}`))
    .map((path) => ({ path, bytes: readFileSync(`${repoRoot}/${path}`) }));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const files = collectSourceFiles(repoRoot);

  // Denominator FIRST (T-14): a scan of zero files is a broken scan, not a clean tree.
  if (files.length === 0) {
    console.error(
      'check-no-control-bytes: scanned 0 files — the glob matched nothing (broken scan).',
    );
    process.exit(1);
  }

  const findings = findControlBytes(files);
  if (findings.length > 0) {
    for (const f of findings) {
      const hex = `0x${f.byte.toString(16).padStart(2, '0')}`;
      console.error(
        `check-no-control-bytes: ${f.path}:${f.line}:${f.column} — raw control byte ${hex} in a text-source file.`,
      );
    }
    console.error(
      'A raw control byte turns a source file BINARY to git (unreviewable diff). Write the `\\x00` escape, ' +
        'never the byte itself (CLAUDE.md §2.9). A text delimiter is better still.',
    );
    process.exit(1);
  }

  console.log(
    `check-no-control-bytes: ${files.length} text-source files clean (no raw C0 control bytes).`,
  );
}
