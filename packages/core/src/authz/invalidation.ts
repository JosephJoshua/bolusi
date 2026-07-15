// Permission-set-change invalidation hooks (02-permissions §8.4–§8.5).
//
// §8.3 says the effective permission set is a dependency of every live query subscription, and
// because ALL reads flow through query handlers (04 §7), re-running them IS the privileged-data
// invalidation — newly forbidden rows and fields drop from every screen on their own. That covers
// everything the query runtime owns.
//
// This registry covers what it does NOT own: §8.4's "module-declared caches" — any cache holding
// query results OUTSIDE the query runtime. v0 has none (media thumbnails are governed by
// 06-media-pipeline), so this ships as the mechanism §8.4 requires to exist BEFORE someone builds
// such a cache — "building such a cache without the hook is forbidden" is only enforceable if the
// hook exists to register with.
//
// §8.5: grow and shrink fire the same hooks. A cache that refreshes on grant but not on revoke is
// the "grant fast, revoke slow" asymmetry the spec explicitly rules out — so the trigger is the
// SYMMETRIC difference, and `permissionSetDelta` is the only way to compute it here.
//
// Platform-free: imports nothing.

/** Called when a permission-set change touches at least one of the hook's declared ids. */
export type PermissionSetChangeHook = (changed: ReadonlySet<string>) => void;

/**
 * Ids that changed between two effective sets — the SYMMETRIC difference, so a revoked id (in
 * `before`, gone from `after`) is as much a change as a granted one (§8.5).
 */
export function permissionSetDelta(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): ReadonlySet<string> {
  const changed = new Set<string>();
  for (const id of before) if (!after.has(id)) changed.add(id); // shrink
  for (const id of after) if (!before.has(id)) changed.add(id); // grow
  return changed;
}

interface Registration {
  readonly ids: ReadonlySet<string>;
  readonly hook: PermissionSetChangeHook;
}

/**
 * The §8.4 hook registry: caches register the permission ids they depend on, and are notified when
 * a permission-set change touches any of them.
 */
export class PermissionInvalidationRegistry {
  private readonly registrations = new Set<Registration>();

  /**
   * Register `hook` against the permission ids the cache depends on. Returns an unsubscribe.
   * Registering with an EMPTY id list is a programming error: a cache that depends on no
   * permission does not hold privileged data, and a hook that can never fire is worse than no hook
   * — it reads as coverage while providing none.
   */
  register(permissionIds: readonly string[], hook: PermissionSetChangeHook): () => void {
    if (permissionIds.length === 0) {
      throw new Error(
        'a permission-set-change hook must declare at least one permission id it depends on (02-permissions §8.4)',
      );
    }
    const registration: Registration = { ids: new Set(permissionIds), hook };
    this.registrations.add(registration);
    return () => {
      this.registrations.delete(registration);
    };
  }

  /** Registered hook count — the denominator for a coverage assertion (T-14). */
  get size(): number {
    return this.registrations.size;
  }

  /**
   * Fire every hook whose declared ids INTERSECT `changed`. Hooks whose ids are untouched stay
   * silent. An empty `changed` set is a no-op — nothing changed, nothing is signalled.
   */
  notify(changed: ReadonlySet<string>): void {
    if (changed.size === 0) return;
    for (const registration of this.registrations) {
      let touched = false;
      for (const id of changed) {
        if (registration.ids.has(id)) {
          touched = true;
          break;
        }
      }
      if (touched) registration.hook(changed);
    }
  }

  /** `notify` over the §8.5 symmetric difference of two effective sets (grow AND shrink). */
  notifyChange(before: ReadonlySet<string>, after: ReadonlySet<string>): void {
    this.notify(permissionSetDelta(before, after));
  }
}
