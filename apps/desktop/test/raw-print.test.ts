// @vitest-environment node
// The main process's spooler call and the PC's print settings file, without Windows: a stand-in
// for PowerShell records what it was given and exits with the code a test picks. The real spooler
// is covered by raw-print.windows.test.ts on a Windows runner.
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeviceSettingsFile } from '../src/main/device-settings.js';
import { sendRaw } from '../src/main/raw-print.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bolusi-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A fake `powershell.exe`: copies the job and its names out, then exits with `code`. */
async function fakePowershell(code: number): Promise<string> {
  const path = join(dir, 'powershell');
  await writeFile(
    path,
    `#!/bin/sh
cp "$BOLUSI_RAW_FILE" "${dir}/sent.prn"
printf '%s\\n%s\\n%s' "$BOLUSI_RAW_PRINTER" "$BOLUSI_RAW_JOB" "$*" > "${dir}/args.txt"
exit ${String(code)}
`,
  );
  await chmod(path, 0o755);
  return path;
}

describe.skipIf(process.platform === 'win32')('raw print', () => {
  it('hands the exact bytes and names over outside the script, and cleans up', async () => {
    const bytes = new Uint8Array([0x1b, 0x40, 0x00, 0xff, 0x0c]);
    const result = await sendRaw('EPSON LX-310 "; Remove-Item', bytes, 'Nota K7Q-0001', {
      powershell: await fakePowershell(0),
    });
    expect(result).toEqual({ ok: true });
    expect(new Uint8Array(await readFile(join(dir, 'sent.prn')))).toEqual(bytes);
    const [printer, job, args] = (await readFile(join(dir, 'args.txt'), 'utf8')).split('\n');
    // The names travel as data; the script itself is fixed and encoded.
    expect(printer).toBe('EPSON LX-310 "; Remove-Item');
    expect(job).toBe('Nota K7Q-0001');
    expect(args).toContain('-EncodedCommand');
    expect(args).not.toContain('EPSON');
  });

  it('reports a refused job as failed', async () => {
    const result = await sendRaw('EPSON', new Uint8Array([1]), 'x', {
      powershell: await fakePowershell(5),
    });
    expect(result).toEqual({ ok: false, problem: 'failed' });
  });

  it('reports a PC without PowerShell as failed rather than throwing', async () => {
    const result = await sendRaw('EPSON', new Uint8Array([1]), 'x', {
      powershell: join(dir, 'missing'),
    });
    expect(result).toEqual({ ok: false, problem: 'failed' });
  });

  it('stops waiting for a spooler that hangs', async () => {
    const path = join(dir, 'hang');
    await writeFile(path, '#!/bin/sh\nsleep 30\n');
    await chmod(path, 0o755);
    const result = await sendRaw('EPSON', new Uint8Array([1]), 'x', {
      powershell: path,
      timeoutMs: 200,
    });
    expect(result).toEqual({ ok: false, problem: 'failed' });
  });
});

describe('device settings file', () => {
  it('starts empty, keeps each change, and survives a reopen', async () => {
    const settings = new DeviceSettingsFile(dir);
    expect(await settings.read()).toEqual({ printer: null, paper: null });
    await Promise.all([
      settings.update({ printer: 'EPSON LX-310' }),
      settings.update({ paper: { preset: 'a4', widthMm: 210, heightMm: 297 } }),
    ]);
    expect(await new DeviceSettingsFile(dir).read()).toEqual({
      printer: 'EPSON LX-310',
      paper: { preset: 'a4', widthMm: 210, heightMm: 297 },
    });
  });

  it('reads a damaged file as empty instead of refusing to print', async () => {
    await writeFile(join(dir, 'device-settings.json'), '{"printer": 42');
    expect(await new DeviceSettingsFile(dir).read()).toEqual({ printer: null, paper: null });
    await writeFile(join(dir, 'device-settings.json'), '{"printer": 42}');
    expect(await new DeviceSettingsFile(dir).read()).toEqual({ printer: null, paper: null });
  });
});
