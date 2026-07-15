// Standalone entry for the §5.4 vectors on the Hermes VM (08 §5.6 stage 6, release-blocking).
//
// Why this exists as its own entry: Hermes ships a SUBSET of Intl (07-i18n §2).
// Intl.NumberFormat and Intl.DateTimeFormat are present on Android, but Intl.PluralRules has
// historically been absent — and i18next-icu's plural selection depends on it. A vector suite
// that only ever runs on Node therefore proves nothing about the device.
//
// This file has no test-runner import so it can be bundled and executed by a bare VM: it prints
// a report and sets a non-zero exit status on mismatch. The stage-6 lane picks the mechanism
// (hermesc bundle vs the Android-emulator job) — task 03 owns that choice for the whole repo,
// and this entry plugs into whichever it lands on.
//
// If the plural vector is the one that fails here, apply the 07-i18n §2 contingency: add
// @formatjs/intl-pluralrules — and nothing else from FormatJS — then re-run.
import { runI18nVectors } from './vectors.js';

declare const console: { log(...args: unknown[]): void };

export function main(): number {
  const results = runI18nVectors();
  const failures = results.filter((result) => !result.ok);

  for (const result of results) {
    const status = result.ok ? 'PASS' : 'FAIL';
    console.log(`i18n-vectors: ${status}  ${result.name}`);
    if (!result.ok) {
      console.log(`  expected ${JSON.stringify(result.expected)}`);
      console.log(`  actual   ${JSON.stringify(result.actual)}`);
    }
  }

  console.log(
    `i18n-vectors: Intl.PluralRules is ${typeof (globalThis as { Intl?: { PluralRules?: unknown } }).Intl?.PluralRules === 'function' ? 'present' : 'MISSING (07-i18n §2 polyfill contingency applies)'}`,
  );

  if (failures.length > 0) {
    console.log(
      `i18n-vectors: ${failures.length}/${results.length} vectors FAILED — release blocker`,
    );
    return 1;
  }
  console.log(`i18n-vectors: all ${results.length} vectors passed`);
  return 0;
}

const exitCode = main();
const runtime = globalThis as { process?: { exitCode?: number } };
if (runtime.process !== undefined) runtime.process.exitCode = exitCode;
