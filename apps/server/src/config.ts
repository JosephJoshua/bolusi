// Server config, read ONCE at boot through a Zod-validated module (security-guide §10) — no
// ad-hoc process.env reads scattered through code. `.env.example` is the authoritative list of
// required vars; secrets live only in the gitignored `.env`.
import { z } from 'zod';

const zConfig = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

export type ServerConfig = { readonly databaseUrl: string; readonly port: number };

/** Validate and normalize the environment. Throws a readable error if a required var is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = zConfig.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid server configuration (security-guide §10): ${detail}`);
  }
  return { databaseUrl: parsed.data.DATABASE_URL, port: parsed.data.PORT };
}
