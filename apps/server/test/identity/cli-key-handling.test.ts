// The system-device private key's storage path (task 17's inherited finding, from task 13's
// review-02 — 2026-07-15). A real security surface, so per CLAUDE.md §2.5 these adversarial tests
// ship WITH the change and before review, not after it.
//
// THE CLAIM: the DEFAULT provisioning path never puts the tenant's Ed25519 signing key on stdout.
//
// THE TRAP THIS FILE IS BUILT AROUND (T-17). "stdout does not contain the key" is an absence
// assertion, and absence is exactly what a broken fixture also produces: a test that asserted it
// against a result whose key was `undefined`, or against a writer that captured nothing, or against
// a CLI that emitted no output at all, would be a triumphant green proving nothing. So every case
// here carries its positive control — the key is a real, non-empty secret; the harness CAN see a
// key on stdout when one is emitted (`--print-key` proves it); and the key really did land in the
// file. The fence and the proof that the fenced thing exists, together.
import { mkdtempSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  defaultKeyPath,
  emitProvisionOutput,
  writeSecretFileSync,
  type ProvisionResult,
} from '../../src/cli/provision-tenant.js';

/** A result whose secrets are DISTINCT, non-empty, and unlike any other string in the output. */
function makeResult(): ProvisionResult {
  return {
    tenantId: '0198f200-0000-7000-8000-00000000a001',
    storeIds: ['0198f200-0000-7000-8000-00000000a003'],
    ownerUserId: '0198f200-0000-7000-8000-00000000a002',
    systemUserId: '0198f200-0000-7000-8000-00000000a004',
    systemDeviceId: '0198f200-0000-7000-8000-00000000a005',
    oneTimePassword: 'PW-ONE-TIME-9c1f4a',
    /**
     * A distinctive marker, deliberately NOT base64-shaped.
     *
     * The first version of this fixture was a realistic base64 blob — and the pre-commit secret
     * scan (`gitleaks`, security-guide §10 / SEC-SECRET-02) rejected the commit: `generic-api-key`
     * on a high-entropy base64 value sitting on a line named `systemDevicePrivateKeyB64`. The
     * scanner was RIGHT, and it is worth leaving the story here rather than an allowlist entry:
     * that line is character-for-character what a real leak looks like, and a repo that teaches
     * itself to wave the rule through on "it's only a test fixture" has disabled the control for
     * the case it exists to catch. The test needs a string it can prove is absent from stdout —
     * entropy was never part of the requirement.
     */
    systemDevicePrivateKeyB64: 'FAKE-KEY-MUST-NOT-REACH-STDOUT',
  };
}

interface Captured {
  readonly stdout: string;
  readonly files: Map<string, string>;
}

/** Drive `emitProvisionOutput` with in-memory ports, capturing everything it emitted. */
function emit(options: { printKey: boolean; keyPath?: string }): Captured {
  const result = makeResult();
  let stdout = '';
  const files = new Map<string, string>();
  emitProvisionOutput(
    result,
    { printKey: options.printKey, keyPath: options.keyPath ?? defaultKeyPath(result.tenantId) },
    {
      write: (line) => {
        stdout += line;
      },
      writeSecretFile: (path, contents) => files.set(path, contents),
    },
  );
  return { stdout, files };
}

describe('provision-tenant key handling (§2.5; task 13 review-02)', () => {
  test('THE FENCE — the default path never writes the private key to stdout', () => {
    const { stdout } = emit({ printKey: false });
    const result = makeResult();

    // The fence.
    expect(stdout).not.toContain(result.systemDevicePrivateKeyB64);

    // THE POSITIVE CONTROLS (T-17) — without these the assertion above is satisfied by a CLI that
    // printed nothing at all, or by a fixture whose key was empty.
    //   1. the key is a real, non-empty secret …
    expect(result.systemDevicePrivateKeyB64.length).toBeGreaterThan(10);
    //   2. … the CLI really did produce output on this path …
    expect(stdout).toContain('tenant provisioned');
    //   3. … and it can and does still print OTHER secrets, so "stdout contains no secret" is not
    //      true by the writer being inert. The one-time password is deliberately still shown.
    expect(stdout).toContain(result.oneTimePassword);
  });

  test('THE POSITIVE CONTROL — --print-key DOES put the key on stdout', () => {
    // This is what makes the fence test above meaningful: the harness demonstrably CAN see the key
    // on stdout. A green fence with no such proof is indistinguishable from a broken capture.
    const { stdout, files } = emit({ printKey: true });
    expect(stdout).toContain(makeResult().systemDevicePrivateKeyB64);
    // … and the explicit path does not ALSO leave it on disk — one copy, where asked.
    expect(files.size).toBe(0);
  });

  test('the default path writes the key to the key file, so it is not merely dropped', () => {
    // "Not on stdout" would also be satisfied by losing the key entirely — which would brick the
    // tenant's conflict signer with no error. The key must be exactly one place: the file.
    const { files } = emit({ printKey: false });
    const path = defaultKeyPath(makeResult().tenantId);
    expect([...files.keys()]).toEqual([path]);
    expect(files.get(path)?.trim()).toBe(makeResult().systemDevicePrivateKeyB64);
  });

  test('the default key path is per-tenant, so two provisionings cannot collide', () => {
    expect(defaultKeyPath('tenant-a')).not.toBe(defaultKeyPath('tenant-b'));
  });
});

describe('writeSecretFileSync — the file is 0600 and never overwritten', () => {
  test('creates the file with mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bolusi-key-'));
    const path = join(dir, 'system-device.key');
    writeSecretFileSync(path, 'SECRET\n');

    expect(readFileSync(path, 'utf8')).toBe('SECRET\n');
    // The permission bits, masked off the file type. 0o600 = owner read/write, nobody else.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('REFUSES to overwrite an existing file rather than clobber a live tenant’s key', () => {
    // `wx`. Two reasons, both real: `writeFileSync(path, data, { mode })` applies `mode` only on
    // CREATE, so writing over an existing 0644 file would silently keep 0644 — the guard would be
    // green and the key world-readable. And a second provisioning run overwriting a live tenant's
    // key file is a mistake with no undo.
    const dir = mkdtempSync(join(tmpdir(), 'bolusi-key-'));
    const path = join(dir, 'system-device.key');
    writeSecretFileSync(path, 'FIRST\n');

    expect(() => writeSecretFileSync(path, 'SECOND\n')).toThrow();
    // The original survived — the refusal is a refusal, not a partial write.
    expect(readFileSync(path, 'utf8')).toBe('FIRST\n');
    expect(existsSync(path)).toBe(true);
  });
});
