// Server config, read ONCE at boot through a Zod-validated module (security-guide §10) — no
// ad-hoc process.env reads scattered through code. `.env.example` is the authoritative list of
// required vars; secrets live only in the gitignored `.env`.
import { z } from 'zod';

const zConfig = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  // OPTIONAL. The directory holding per-tenant system-device signing keys (01 §3.6, 10-db §12) —
  // the deployment-owned secret store that ENABLES conflict detection. Absent ⇒ no key store is
  // built and detection stays off (the honest v0 default; sync/system-key-store.ts). Present ⇒
  // a DirectorySystemKeyStore reads `system-device-<tenantId>.key` (the file `provision-tenant`
  // writes) from it. Never a required var: an unset value is a valid, deliberate "detection off".
  SYSTEM_KEY_DIR: z.string().min(1).optional(),
});

export type ServerConfig = {
  readonly databaseUrl: string;
  readonly port: number;
  /** Directory of per-tenant system-device signing keys; absent ⇒ conflict detection off. */
  readonly systemKeyDir?: string;
};

/** Validate and normalize the environment. Throws a readable error if a required var is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = zConfig.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid server configuration (security-guide §10): ${detail}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    port: parsed.data.PORT,
    ...(parsed.data.SYSTEM_KEY_DIR === undefined
      ? {}
      : { systemKeyDir: parsed.data.SYSTEM_KEY_DIR }),
  };
}
