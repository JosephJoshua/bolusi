// Sending bytes to a Windows printer as a RAW job, the way a dot-matrix printer takes ESC/P: the
// spooler passes them to the port untouched, with no driver rendering in between. Node has no
// spooler API and a native module would need a build per Electron, so a short PowerShell script
// calls winspool.drv itself. Plain Node (no Electron) so it can be tested on a Windows machine alone.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Why a job did not reach the spooler: no such printer here, or Windows refused it. */
export type RawPrintProblem = 'printerMissing' | 'failed';

export type RawPrintResult =
  { readonly ok: true } | { readonly ok: false; readonly problem: RawPrintProblem };

// ERROR_INVALID_PRINTER_NAME: the printer was removed, renamed, or never installed on this PC.
const INVALID_PRINTER_NAME = 1801;
// Compiling the helper takes a second or two on a slow PC; a spooler that hangs past this is stuck.
const TIMEOUT_MS = 60_000;

// The names and the file arrive in environment variables, never inside the script text, so a printer
// or job name cannot change what runs. Exit code: 0 sent, else the Win32 error that stopped it.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BolusiRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DocInfo {
    [MarshalAs(UnmanagedType.LPWStr)] public string DocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string OutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string DataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr printer);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr printer, int level, [In] DocInfo doc);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr printer);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr printer);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr printer);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr printer, byte[] bytes, int count, out int written);

  public static int Send(string name, string job, byte[] bytes) {
    IntPtr printer;
    if (!OpenPrinter(name, out printer, IntPtr.Zero)) return Marshal.GetLastWin32Error();
    try {
      DocInfo doc = new DocInfo();
      doc.DocName = job;
      doc.DataType = "RAW";
      if (StartDocPrinter(printer, 1, doc) == 0) return Marshal.GetLastWin32Error();
      try {
        if (!StartPagePrinter(printer)) return Marshal.GetLastWin32Error();
        int written;
        bool sent = WritePrinter(printer, bytes, bytes.Length, out written);
        int error = sent ? 0 : Marshal.GetLastWin32Error();
        EndPagePrinter(printer);
        if (!sent) return error;
        if (written != bytes.Length) return 29; // ERROR_WRITE_FAULT
        return 0;
      } finally {
        EndDocPrinter(printer);
      }
    } finally {
      ClosePrinter(printer);
    }
  }
}
'@
$bytes = [System.IO.File]::ReadAllBytes($env:BOLUSI_RAW_FILE)
exit ([BolusiRawPrinter]::Send($env:BOLUSI_RAW_PRINTER, $env:BOLUSI_RAW_JOB, $bytes))
`;

// -EncodedCommand takes the script whole (UTF-16LE, base64); piping it to stdin runs it line by line.
const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64');

export interface RawPrintOptions {
  /** Where PowerShell is; tests point it elsewhere. */
  readonly powershell?: string;
  readonly timeoutMs?: number;
}

function runScript(env: NodeJS.ProcessEnv, options: RawPrintOptions): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      options.powershell ?? 'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        ENCODED_SCRIPT,
      ],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    // A stuck spooler call is given up on at once, whatever is still holding its output open.
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, options.timeoutMs ?? TIMEOUT_MS);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && stderr !== '') console.warn('raw print:', stderr.trim());
      resolve(code);
    });
  });
}

/** Spool `bytes` to the named printer as one RAW job. Resolves once Windows has queued it. */
export async function sendRaw(
  printer: string,
  bytes: Uint8Array,
  jobName: string,
  options: RawPrintOptions = {},
): Promise<RawPrintResult> {
  const dir = await mkdtemp(join(tmpdir(), 'bolusi-print-'));
  try {
    const file = join(dir, 'job.prn');
    await writeFile(file, bytes);
    const code = await runScript(
      { BOLUSI_RAW_PRINTER: printer, BOLUSI_RAW_JOB: jobName, BOLUSI_RAW_FILE: file },
      options,
    );
    if (code === 0) return { ok: true };
    return { ok: false, problem: code === INVALID_PRINTER_NAME ? 'printerMissing' : 'failed' };
  } finally {
    // A killed PowerShell may still hold the file on Windows; the temp folder is cleaned up later.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
