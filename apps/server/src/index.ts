// Package entry — exports ONLY, no side effects: later tasks import the app for
// in-process testing (harness, integration suites). Server boot lives in main.ts.
export { routes } from './app.js';
export type { AppType } from './app.js';
