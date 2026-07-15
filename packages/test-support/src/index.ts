// @bolusi/test-support — test-only; shipping source never imports this package (08 §3.3).
// Golden vectors + the determinism kit land in later tasks (ai-docs/tasks/_index.md).
export const PACKAGE_NAME = '@bolusi/test-support' as const;

export * from './driver-conformance/index.js';
