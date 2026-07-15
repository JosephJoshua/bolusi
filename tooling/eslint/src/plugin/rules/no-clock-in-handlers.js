// bolusi/no-clock-in-handlers — 04-module-contract §5.2's purity rule, at authoring time:
//
//   "No `Date.now()` in handlers — timestamp is stamped by the runtime for the whole command
//    atomically."
//
// WHY THIS MATTERS MORE THAN IT LOOKS. A handler reading the clock does not just break a
// convention — it breaks CONVERGENCE. 04 §5.2 stamps ONE timestamp per command so every op the
// command emits sorts identically on every device (canonical order is `timestamp, deviceId, seq`
// — 05 §4). A handler that stamps its own time gives two ops of one command two times, and the
// projection can then fold them in different orders on different devices. That is not a bug that
// shows up in the handler's test; it shows up as a convergence failure in a chaos run, three
// tasks later, attributed to the projection engine.
//
// `Math.random()` and `fetch()` are the same argument for ids and I/O: ids come from
// `ctx.newId()` (an injected, seeded IdSource — testing-guide T-6), reads come from `ctx.query`,
// and a handler that reaches the network is not replayable at all.
//
// WHAT THIS RULE CANNOT DO, AND WHAT COVERS IT. It is an AST rule, so it sees only what is
// written literally in a handler file: `globalThis[key].now()` with a computed key is invisible
// to it, and so is anything a handler calls in another file. That gap is covered by the runtime
// purity guard (packages/core/test/runtime/_purity.ts), which poisons the globals for the
// duration of handler invocation and therefore catches the call wherever it actually lives. Three
// locks, none sufficient alone: the type (no clock on ctx), this rule, and the runtime guard.
//
// SCOPE. Command-handler files in packages/modules, per the schema-file naming convention 08 §5.2
// already established for `bolusi/no-float-money` — the shared config below binds the paths.

/** The banned member expressions: `<object>.<property>()`. */
const BANNED_MEMBERS = [
  { object: 'Date', property: 'now' },
  { object: 'Math', property: 'random' },
  { object: 'performance', property: 'now' },
];

/** The banned bare calls / constructions. */
const BANNED_CALLEES = new Set([
  'fetch',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'requestAnimationFrame',
  'queueMicrotask',
]);

/**
 * The replacement to suggest for each banned effect — a rule that only says "no" gets disabled.
 *
 * Exported so the RuleTester fixtures can hydrate the message's `{{remedy}}` placeholder from the
 * SAME table rather than re-typing the copy (which would then drift, and would make the fixtures
 * assert the wording instead of the behaviour).
 */
export const REMEDY = {
  'Date.now': 'the runtime stamps `timestamp` once per command (04 §5.2)',
  'new Date': 'the runtime stamps `timestamp` once per command (04 §5.2)',
  'Math.random': 'use `ctx.newId()` — an injected, seeded UUIDv7 source (04 §5.2, T-6)',
  'performance.now': 'the runtime stamps `timestamp` once per command (04 §5.2)',
  fetch: 'handlers do no I/O — read via `ctx.query()`, write by returning op drafts (04 §5.2)',
  setTimeout: 'handlers are synchronous-in-spirit and own no timers (04 §5.2)',
  setInterval: 'handlers are synchronous-in-spirit and own no timers (04 §5.2)',
  setImmediate: 'handlers are synchronous-in-spirit and own no timers (04 §5.2)',
  requestAnimationFrame: 'handlers are platform-free and never touch a frame loop (04 §5.2)',
  queueMicrotask: 'handlers are synchronous-in-spirit and own no timers (04 §5.2)',
};

/** True when the expression is `globalThis.X` / `window.X` / `global.X`. */
function isGlobalObject(node) {
  return (
    node.type === 'Identifier' &&
    (node.name === 'globalThis' || node.name === 'window' || node.name === 'global')
  );
}

/**
 * The identifier a callee ultimately names, unwrapping ONE level of global prefix:
 * `fetch` → `fetch`; `globalThis.fetch` → `fetch`. Returns null for anything else.
 */
function bareCalleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    isGlobalObject(callee.object) &&
    callee.property.type === 'Identifier'
  ) {
    return callee.property.name;
  }
  return null;
}

/**
 * Match `Date.now` / `globalThis.Date.now` (and the other banned members).
 * Returns the `<object>.<property>` label, or null.
 */
function bannedMemberName(callee) {
  if (callee.type !== 'MemberExpression' || callee.computed) return null;
  if (callee.property.type !== 'Identifier') return null;

  let objectNode = callee.object;
  // Unwrap `globalThis.Date.now` → treat as `Date.now`.
  if (
    objectNode.type === 'MemberExpression' &&
    !objectNode.computed &&
    isGlobalObject(objectNode.object) &&
    objectNode.property.type === 'Identifier'
  ) {
    objectNode = objectNode.property;
  }
  if (objectNode.type !== 'Identifier') return null;

  const match = BANNED_MEMBERS.find(
    (banned) => banned.object === objectNode.name && banned.property === callee.property.name,
  );
  return match === undefined ? null : `${match.object}.${match.property}`;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Command handlers are pure: no clock, no rng, no network, no timers (ai-docs/04-module-contract.md §5.2).',
    },
    messages: {
      ambientEffect:
        "Command handlers are pure — '{{effect}}' is not available to them (04-module-contract §5.2): {{remedy}}.",
    },
    schema: [],
  },
  create(context) {
    const report = (node, effect) => {
      context.report({
        node,
        messageId: 'ambientEffect',
        data: { effect, remedy: REMEDY[effect] ?? 'use the injected ports on `ctx` (04 §5.2)' },
      });
    };

    return {
      CallExpression(node) {
        const member = bannedMemberName(node.callee);
        if (member !== null) {
          report(node, member);
          return;
        }
        const bare = bareCalleeName(node.callee);
        if (bare !== null && BANNED_CALLEES.has(bare)) report(node, bare);
      },

      NewExpression(node) {
        // `new Date()` reads the clock; `new Date(ms)` is a pure conversion of a value the handler
        // was already given (typically off an op or an input), so it stays legal — banning it
        // would push handlers into worse workarounds for a non-problem.
        const name = bareCalleeName(node.callee);
        if (name === 'Date' && node.arguments.length === 0) report(node, 'new Date');
      },
    };
  },
};
