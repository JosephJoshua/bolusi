// Dev-loop boot shell (08 §5.1 `pnpm dev`). Zod-validated config module + middleware
// chain are task 12's; PORT is the only env read the shell needs (security-guide §10
// names DATABASE_URL + PORT as the .env surface).
import { serve } from '@hono/node-server';

import { routes } from './app.js';

const port = Number(process.env['PORT'] ?? 3000);

serve({ fetch: routes.fetch, port }, (info) => {
  console.log(`@bolusi/server shell listening on :${info.port}`);
});

export { routes } from './app.js';
export type { AppType } from './app.js';
