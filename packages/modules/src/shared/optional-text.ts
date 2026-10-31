// Optional text fields, the same in every module: a command takes blank as no text, and a signed
// payload carries either real text or null, never an empty string.
import { z } from 'zod';

/** Command input: trimmed, and blank is no text. */
export const zOptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((value) => (value === null || value === '' ? null : value));

/** Op payload: text with something in it, or null. */
export const zOptionalPayloadText = (max: number) => z.string().trim().min(1).max(max).nullable();
