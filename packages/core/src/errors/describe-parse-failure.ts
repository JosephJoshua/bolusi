/**
 * A compact, structured description of a parse failure for `VALIDATION_FAILED` details.
 *
 * Zod's `ZodError` carries `issues`; anything else contributes its NAME only. Deliberately does
 * NOT pass the raw error through: `details` is surfaced to logs/telemetry (03 §12), and a schema
 * error can quote the rejected input verbatim — which is how a mistyped PIN ends up in a log file.
 *
 * The one implementation for both execution paths (runtime/execute.ts commands and
 * query/execute.ts queries) — the log-hygiene rule is a single policy, so a tightening here
 * reaches every caller (CLAUDE.md §2.8).
 */
export function describeParseFailure(cause: unknown): string {
  const issues =
    typeof cause === 'object' && cause !== null
      ? (cause as { issues?: unknown }).issues
      : undefined;
  if (Array.isArray(issues)) {
    return issues
      .map((issue: unknown) => {
        // `path` and `code` ONLY. Zod's `message` and `keys` can quote caller-supplied text (a
        // rejected value, an unrecognized key name); `path` is schema structure and `code` is a
        // fixed enum, so neither can carry data. This is the whole reason the issue is
        // reconstructed rather than passed through.
        const { path, code } = (issue ?? {}) as { path?: unknown; code?: unknown };
        const where = Array.isArray(path) && path.length > 0 ? path.join('.') : '(root)';
        return `${where}: ${String(code ?? 'invalid')}`;
      })
      .join('; ');
  }
  return cause instanceof Error ? cause.name : 'parse failed';
}
