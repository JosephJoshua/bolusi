// Boot entry for the dev loop (08 §5.1 `pnpm dev` → tsx watch src/main.ts). The package
// entry (index.ts) stays side-effect-free. Zod-validated config module + middleware chain
// are task 12's; PORT is the only env read the boot shell needs (security-guide §10 names
// DATABASE_URL + PORT as the .env surface).
import { serve } from '@hono/node-server';

import { routes } from './app.js';

const port = Number(process.env['PORT'] ?? 3000);

serve({ fetch: routes.fetch, port }, (info) => {
  console.log(`@bolusi/server shell listening on :${info.port}`);
});
