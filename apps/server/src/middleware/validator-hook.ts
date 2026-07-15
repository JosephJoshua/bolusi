// The single shared zValidator hook (api/00 §7.1). zValidator's DEFAULT failure is a 400 with
// the raw Zod error — never shipped. Every `zValidator('json', schema)` goes through `zJson`,
// which emits the §6 envelope with status 422 VALIDATION_FAILED and maps ZodError.issues to
// { path, code, message } and NOTHING else — no `input` echo (payloads may hold sensitive data;
// @bolusi/schemas' zValidationIssue is `.strict()` for exactly this reason).
import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import type { ValidationIssue } from '@bolusi/schemas';

import type { AppEnv } from '../env.js';
import { respondError } from '../errors.js';

/** `zValidator('json', schema)` wired to the shared 422 hook. Use everywhere; never bare zValidator. */
export function zJson<T extends ZodType>(schema: T) {
  return zValidator('json', schema, (result, c) => {
    if (result.success) return undefined;
    const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.map((seg) => (typeof seg === 'number' ? seg : String(seg))),
      code: issue.code,
      message: issue.message,
    }));
    return respondError(c as unknown as Context<AppEnv>, 'VALIDATION_FAILED', { issues });
  });
}
