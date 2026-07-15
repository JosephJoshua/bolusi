// Package entry — exports ONLY, no side effects: later tasks and the harness import the app for
// in-process testing (harness, integration suites). Server boot lives in main.ts.
export { routes, createApp } from './app.js';
export type { AppType } from './app.js';
