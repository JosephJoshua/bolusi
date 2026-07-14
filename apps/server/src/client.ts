// Types-only subpath export (08 §4.3): the built output of this file carries ZERO runtime
// code. `import type { AppType } from '@bolusi/server/client'` is the single permitted
// app→app edge (type-only, lint-enforced by bolusi/boundaries).
export type { AppType } from './app.js';
