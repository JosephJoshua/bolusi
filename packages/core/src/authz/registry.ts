// Permission registry (02-permissions §2–§3): the static vocabulary, assembled at STARTUP from
// module manifests. Never mutated at runtime, never per tenant (§1).
//
// The registry is identical on client and server for a given build (same shared package).
// Version skew between builds is handled by fail-closed evaluation (§6, evaluate.ts): an id
// absent from THIS build's registry can never be granted, and a grant list naming an unknown id
// contributes nothing.
//
// Assembly is a STARTUP FAILURE surface, not a warning surface (§3.2 rules 1–4). Every throw here
// happens before the first command runs: a process that booted with a command requiring a
// permission its own registry does not define would evaluate that command against an
// unresolvable id forever — DENY `unknown_permission` on every call, a permanent silent outage
// dressed as an authorization decision. Failing the boot is the loud version of the same fact.
//
// Platform-free: this file imports nothing (08-stack-and-repo §3.3).

/** Which scope a permission's check evaluates in (§3.1). Bound to the PERMISSION, not the command. */
export type PermissionScope = 'tenant' | 'store';

/**
 * Permission id format (§2): `<module>.<action>`, `<module>` = the owning manifest id, `<action>`
 * snake_case and present tense. Ids are immutable once shipped — role grant lists and denial ops
 * reference them as strings in an append-only log.
 */
export const PERMISSION_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** A registry entry (§3.1). `module`/`action` are DERIVED from the id — never declared twice. */
export interface PermissionEntry {
  /** `<module>.<action>` (§2). Map key in the manifest. */
  readonly id: string;
  /** Derived from the id. */
  readonly module: string;
  /** Derived from the id. */
  readonly action: string;
  /** Which scope the check evaluates in (§5). */
  readonly scope: PermissionScope;
  /** Grants that should feel like a decision, not a checkbox (PRD-011 §5, §6.4). */
  readonly isDangerous: boolean;
  /**
   * Canonical ENGLISH plain-business-language copy — what this lets someone do to the BUSINESS,
   * written for a shop owner (§3.1). The label catalog's derived keys
   * `permission.<module>.<action>.name|.description` (07-i18n §3.1) are authored from this, and
   * fall back to it when a catalog key is missing.
   */
  readonly description: string;
}

/** What a module manifest declares per permission (§3.2). The id is the map KEY. */
export type PermissionDeclaration = Omit<PermissionEntry, 'id' | 'module' | 'action'>;

/**
 * A command/query's authz-facing slice (04 §5/§6): the permission it requires. `defineModule`
 * (task 11) produces the full manifest; this is the slice assembly consumes, so the registry never
 * depends on handlers, payload schemas, or screens.
 */
export interface PermissionRequiringSurface {
  readonly permission: string;
}

/**
 * The authz-facing view of a module manifest (§3.2) — the same split the projection engine makes
 * with `ModuleProjectionManifest`: the module id, its `permissions` block, and the
 * commands/queries whose `permission` references assembly must resolve (rule 3).
 */
export interface ModulePermissionManifest {
  /** Lowercase module id (04 §1) — prefixes every permission it declares. */
  readonly id: string;
  /** The `permissions` block (§3.2). Absent = declares none. */
  readonly permissions?: Readonly<Record<string, PermissionDeclaration>>;
  /** Command name → its slice. Every `permission` MUST resolve (rule 3). */
  readonly commands?: Readonly<Record<string, PermissionRequiringSurface>>;
  /** Query name → its slice. Checked identically to commands (04 §6). */
  readonly queries?: Readonly<Record<string, PermissionRequiringSurface>>;
}

/** A startup failure (§3.2). Thrown during assembly — never at runtime, never demoted to a warning. */
export class PermissionRegistryError extends Error {
  override readonly name = 'PermissionRegistryError';
  constructor(message: string) {
    super(message);
  }
}

/** One command/query → permission reference: rule 3's unit of work and the T-14 denominator. */
export interface PermissionReference {
  /** The declaring module's id. */
  readonly module: string;
  readonly surface: 'command' | 'query';
  /** The command/query name (the manifest key). */
  readonly name: string;
  /** The permission id it requires. */
  readonly permission: string;
}

/**
 * Every command/query → permission reference across the given modules, in module order.
 *
 * Exported so a coverage check can assert its own DENOMINATOR (testing-guide T-14): "every
 * command's permission resolves" is a vacuous assertion unless the test also states how many
 * references it expected to check — a manifest slice that silently parsed to zero commands would
 * otherwise report green. `assemblePermissionRegistry` validates exactly this list, so a test can
 * count it and hold assembly to the same total.
 */
export function collectPermissionReferences(
  modules: readonly ModulePermissionManifest[],
): readonly PermissionReference[] {
  const references: PermissionReference[] = [];
  for (const module of modules) {
    for (const [name, surface] of Object.entries(module.commands ?? {})) {
      references.push({
        module: module.id,
        surface: 'command',
        name,
        permission: surface.permission,
      });
    }
    for (const [name, surface] of Object.entries(module.queries ?? {})) {
      references.push({
        module: module.id,
        surface: 'query',
        name,
        permission: surface.permission,
      });
    }
  }
  return references;
}

/**
 * The assembled registry (§3). Read-only by construction: there is no `register`, no `add`, no
 * `delete` — the vocabulary is fixed at assembly and changes only with an app release (§1).
 */
export class PermissionRegistry {
  private readonly entries: ReadonlyMap<string, PermissionEntry>;

  /** Prefer `assemblePermissionRegistry`; this constructor is the assembled-map seam. */
  constructor(entries: ReadonlyMap<string, PermissionEntry>) {
    this.entries = entries;
  }

  /** The entry, or `undefined` when the id is not in THIS build's registry → DENY (§5.2 step 1). */
  get(id: string): PermissionEntry | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Entry count — the registry's own denominator (T-14). */
  get size(): number {
    return this.entries.size;
  }

  /** All ids, sorted — stable output for the role editor and for tests. */
  ids(): readonly string[] {
    return [...this.entries.keys()].sort();
  }

  /** All entries, in `ids()` order. */
  all(): readonly PermissionEntry[] {
    return this.ids().map((id) => this.entries.get(id) as PermissionEntry);
  }
}

/**
 * Assemble the registry from module manifests (§3.2 rules 1–4). Throws `PermissionRegistryError`
 * — a STARTUP FAILURE — on:
 *
 *  1. an id violating the §2 format, or whose prefix ≠ the declaring module's id (rule 4);
 *  2. a duplicate id across modules (rule 2);
 *  3. a duplicate module id;
 *  4. a command/query `permission` that resolves to no entry (rule 3).
 *
 * Rule 3 is checked LAST and against the fully merged registry: v0 forbids cross-module
 * permission use by lint (§2), but assembly's job is resolution, and a command may legitimately
 * reference a permission declared by a module that appears later in the list.
 */
export function assemblePermissionRegistry(
  modules: readonly ModulePermissionManifest[],
): PermissionRegistry {
  const entries = new Map<string, PermissionEntry>();
  const declaringModule = new Map<string, string>();
  const seenModules = new Set<string>();

  for (const module of modules) {
    if (seenModules.has(module.id)) {
      throw new PermissionRegistryError(`module already registered: ${module.id}`);
    }
    seenModules.add(module.id);

    for (const [id, declaration] of Object.entries(module.permissions ?? {})) {
      // §2 format + rule 4. Checked before the duplicate test so a malformed id always reports as
      // malformed, whichever module declares it first.
      if (!PERMISSION_ID_PATTERN.test(id)) {
        throw new PermissionRegistryError(
          `permission id ${JSON.stringify(id)} (module ${module.id}) is not <module>.<action> per 02-permissions §2 (${String(PERMISSION_ID_PATTERN)})`,
        );
      }
      const separator = id.indexOf('.');
      const prefix = id.slice(0, separator);
      const action = id.slice(separator + 1);
      if (prefix !== module.id) {
        throw new PermissionRegistryError(
          `permission id ${id} is declared by module ${module.id} but its prefix is ${prefix} — a manifest may declare permissions only under its own id (02-permissions §2, §3.2 rule 4)`,
        );
      }
      // Rule 2.
      const existing = declaringModule.get(id);
      if (existing !== undefined) {
        throw new PermissionRegistryError(
          `duplicate permission id ${id}: declared by both ${existing} and ${module.id} (02-permissions §3.2 rule 2)`,
        );
      }
      declaringModule.set(id, module.id);
      entries.set(id, {
        id,
        module: prefix,
        action,
        scope: declaration.scope,
        isDangerous: declaration.isDangerous,
        description: declaration.description,
      });
    }
  }

  // Rule 3, against the MERGED registry.
  for (const reference of collectPermissionReferences(modules)) {
    if (!entries.has(reference.permission)) {
      throw new PermissionRegistryError(
        `${reference.surface} ${reference.module}.${reference.name} requires permission ${reference.permission}, which no registered module declares (02-permissions §3.2 rule 3)`,
      );
    }
  }

  return new PermissionRegistry(entries);
}
