// Permission-scoped sync (owner decision 2026-10-31): a device receives only the ops its people may
// read. Every op type declares the permission needed to see it (`OperationDeclaration.read`); the
// server sends a device the types its read set covers, and the device drops what it may no longer
// read. Both sides answer "which types" from the same registry through these helpers.
import type { OperationRegistry } from '../module/registry.js';

/** The op-type facts read scoping needs: every type and the permission needed to see it. */
export type ReadScopeRegistry = Pick<OperationRegistry, 'types' | 'readPermissionFor'>;

/** Every read permission some op type names, sorted: the vocabulary a read set is drawn from. */
export function readPermissionsOf(registry: ReadScopeRegistry): readonly string[] {
  const reads = new Set<string>();
  for (const type of registry.types()) {
    const read = registry.readPermissionFor(type);
    if (typeof read === 'string') reads.add(read);
  }
  return [...reads].sort();
}

/**
 * A device's read set: the read permissions among `permissions` (what its people hold), sorted, so
 * two sets compare as strings. Permissions no op type reads are left out, so granting one does not
 * look like a change in what the device receives.
 */
export function readSetOf(
  registry: ReadScopeRegistry,
  permissions: Iterable<string>,
): readonly string[] {
  const held = new Set(permissions);
  return readPermissionsOf(registry).filter((read) => held.has(read));
}

/** The op types a device with this read set receives: every type it may read, plus the unscoped. */
export function typesReadableWith(
  registry: ReadScopeRegistry,
  readSet: Iterable<string>,
): readonly string[] {
  const reads = new Set(readSet);
  return registry.types().filter((type) => {
    const read = registry.readPermissionFor(type);
    return read === null || (read !== undefined && reads.has(read));
  });
}

/** The op types read with exactly these permissions: what a grown read set catches up on, or a shrunk one drops. */
export function typesReadWith(
  registry: ReadScopeRegistry,
  reads: Iterable<string>,
): readonly string[] {
  const wanted = new Set(reads);
  return registry.types().filter((type) => {
    const read = registry.readPermissionFor(type);
    return typeof read === 'string' && wanted.has(read);
  });
}

/** What changed between two read sets: permissions to catch up on and permissions to drop. */
export function readSetChange(
  before: readonly string[],
  after: readonly string[],
): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  const was = new Set(before);
  const now = new Set(after);
  return {
    added: after.filter((read) => !was.has(read)),
    removed: before.filter((read) => !now.has(read)),
  };
}
