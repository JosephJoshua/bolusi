// bolusi/runtime-emission-allowlist — 04-module-contract §5.1 / 02-permissions §4:
//
//   "Commands are the only write path — with exactly five lint-enforced exceptions the RUNTIME
//    itself appends without a command: auth.user_switched, auth.session_ended,
//    auth.permission_denied, auth.pin_locked_out, auth.device_enrolled. Nothing else."
//
// THIS RULE IS THE "lint-enforced" IN THAT SENTENCE. The spec says the list is lint-enforced; this
// is the lint. Two prongs, because there are two ways to append without a command:
//
//   PRONG A — through the channel, with an unsanctioned type: `emitRuntimeOp({ type: 'notes.…' })`.
//     The runtime rejects this too (`assertSanctionedEmission`), but at runtime, on the device,
//     after the code shipped. This catches it in the editor.
//
//   PRONG B — around the channel entirely: calling the op-append path (`appendLocalOps`) directly
//     from somewhere that is not the command runtime. That is the more dangerous shape, because
//     nothing at runtime would stop it: the append path cannot know whether its caller was a
//     command. Only an allowlist of files can say that, so this prong is file-scoped.
//
// WHY THE CLOSED SET IS NOT DUPLICATED HERE. The five live once, in
// `packages/core/src/runtime/runtime-emissions.ts`. A hand-copied list in a lint rule is exactly
// how a sixth type gets in — the copy drifts, and the rule then enforces last month's spec. The
// rule reads its set from the `sanctionedTypes` option, and the shared config passes the five;
// core's own suite pins the constant against 04 §5.1.
//
// WHAT THIS RULE CANNOT DO. Only LITERAL `type` values are checked — the same documented limit as
// `bolusi/permission-module-prefix`. A type built from a variable is invisible to a static rule,
// and is covered by TypeScript instead: `RuntimeEmissionDraft.type` is typed
// `SanctionedRuntimeEmissionType`, so a non-literal must still be one of the five to compile. The
// runtime `assertSanctionedEmission` is the third lock, for values that cross a boundary untyped.

/** The channel's method name (packages/core/src/runtime/execute.ts). */
const CHANNEL_CALLEES = new Set(['emitRuntimeOp']);

/** The op-append entry point — the thing a non-command append would have to reach. */
const APPEND_CALLEES = new Set(['appendLocalOps']);

/** The callee's bare name: `f()` → `f`; `x.f()` → `f`; `this.#f()` → `f`. */
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') {
    if (callee.property.type === 'Identifier') return callee.property.name;
    if (callee.property.type === 'PrivateIdentifier') return callee.property.name;
  }
  return null;
}

/** Find a non-computed property by name on an object expression. */
function findProperty(objectExpression, name) {
  return (
    objectExpression.properties.find(
      (property) =>
        property.type === 'Property' &&
        !property.computed &&
        ((property.key.type === 'Identifier' && property.key.name === name) ||
          (property.key.type === 'Literal' && property.key.value === name)),
    ) ?? null
  );
}

/** Normalize a filename to a repo-relative POSIX path so allowlist entries are portable. */
function relativePath(filename) {
  const posix = filename.split('\\').join('/');
  const marker = posix.lastIndexOf('/packages/');
  if (marker !== -1) return posix.slice(marker + 1);
  const apps = posix.lastIndexOf('/apps/');
  if (apps !== -1) return posix.slice(apps + 1);
  return posix;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Only the five sanctioned op types may be appended outside a command, and only through the runtime emission channel (ai-docs/04-module-contract.md §5.1).',
    },
    messages: {
      unsanctionedType:
        "'{{type}}' is not a sanctioned runtime emission. Commands are the only write path; the runtime appends without a command for exactly these five types: {{sanctioned}} (04-module-contract §5.1, 02-permissions §4). Adding to this list changes 04 §5 first.",
      appendOutsideRuntime:
        "'{{callee}}' appends to the op log directly, bypassing the command layer. Only the command runtime may call it ({{allowed}}); everything else writes by returning op drafts from a command handler (04-module-contract §5.1).",
    },
    schema: [
      {
        type: 'object',
        properties: {
          /** The closed set (04 §5.1). Passed by the shared config from core's own constant. */
          sanctionedTypes: { type: 'array', items: { type: 'string' } },
          /** Repo-relative files permitted to call the op-append path directly. */
          allowFiles: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    const sanctioned = new Set(options.sanctionedTypes ?? []);
    const allowFiles = options.allowFiles ?? [];
    const filename = relativePath(context.filename ?? context.getFilename());
    const fileAllowed = allowFiles.some((allowed) => filename.endsWith(allowed));

    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === null) return;

        // PRONG B — a direct op-log append from outside the runtime.
        if (APPEND_CALLEES.has(name) && !fileAllowed) {
          context.report({
            node,
            messageId: 'appendOutsideRuntime',
            data: {
              callee: name,
              allowed: allowFiles.length > 0 ? allowFiles.join(', ') : '(no files allowlisted)',
            },
          });
          return;
        }

        // PRONG A — the channel, with a literal, unsanctioned type.
        if (!CHANNEL_CALLEES.has(name)) return;
        const [argument] = node.arguments;
        if (argument === undefined || argument.type !== 'ObjectExpression') return;
        const typeProperty = findProperty(argument, 'type');
        if (typeProperty === null) return;
        const { value } = typeProperty;
        // Non-literal types are TypeScript's job (see the file header) — a static rule cannot
        // resolve them, and guessing would produce false positives on legitimate constants.
        if (value.type !== 'Literal' || typeof value.value !== 'string') return;
        if (sanctioned.has(value.value)) return;

        context.report({
          node: typeProperty,
          messageId: 'unsanctionedType',
          data: {
            type: value.value,
            sanctioned: [...sanctioned].join(', ') || '(none configured)',
          },
        });
      },
    };
  },
};
