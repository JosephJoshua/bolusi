// Package entry, exports only and no side effects: the harness and integration suites import the
// app in-process. Server boot lives in main.ts.
export { routes, createApp } from './app.js';
export type { AppType } from './app.js';
export { serveWithRealtime } from './realtime/serve.js';
