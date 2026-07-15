// bolusi/no-float-money (08-stack-and-repo §5.2; money is integer IDR — 05-operation-log §3).
// Scope (set by the shared config): packages/schemas + packages/modules.
// Prongs:
//   1. Zod float constructors                      — everywhere the rule is enabled:
//      • z.number() / z.coerce.number() missing .int()
//      • z.float64() / z.float32()  (always — a declared float format; .int() on top is a
//        contradiction, not a fix)
//   2. parseFloat/Number.parseFloat/toFixed on
//      money-named identifiers                     — everywhere the rule is enabled.
//   3. non-integer numeric literals                — SCHEMA FILES ONLY (opt-in via the
//      `numericLiterals` option; UI code like `opacity: 0.5` is legitimate).
// Schema-file convention (documented in 08 §5.2): all of packages/schemas/src/**, plus
// packages/modules files named *.schema.ts(x) or schema|schemas|ops|operations|commands|
// queries.ts — the shared config wires prong 3 to exactly those globs.
//
// Prong-1 constructor class (ground truth: zod 4.4.3). Float-producing numeric ctors are
// `number`, `float32`, `float64`, `nan`, and `coerce.number` — all covered above except
// `nan`: z.nan() admits ONLY NaN, so it cannot express a money amount at all (and NaN is
// not JCS-serializable, so 05 §3's canonicalization rejects it independently). Integer
// ctors (`int`, `int32`, `int64`, `bigint`, and `.int()` chains) are the sanctioned money
// shapes and are never flagged. Known limitation (shared with the pre-existing z.number
// prong, not introduced by the float ctors): this rule is syntactic, so an indirection
// such as `const n = z.float64; n()` escapes it — catching that needs type information.
//
// Prong-1 CARVE-OUT — mechanism: allowlisted FILE **and** allowlisted PROPERTY NAME, both
// required (conjunction), mirroring bolusi/no-op-table-update's allowFiles+allowColumns.
// The only carve-out in the repo is envelope.ts's `zLocation` (lat/lng/accuracyMeters):
// location rides in the signed ENVELOPE, not the payload, and 05 §3's "no floats" rule is
// scoped to payloads. z.float64() is in fact STRICTER than z.number() there — it rejects
// NaN/Infinity, so every admitted value stays JCS-serializable.
// Why the conjunction rather than either half alone:
//   • file-only would make envelope.ts a blanket float pass — `amountIdr: z.float64()`
//     next to the location shape would lint clean.
//   • prop-only would exempt `lat: z.float64()` in a module PAYLOAD schema, which 05 §3
//     forbids — the carve-out is legitimate *because* location is envelope, not payload.
// Both dimensions are pinned by invalid-cases in the test file; drop either and a test
// goes red. Default is NO exemption: absent options, every float ctor is an error.

const MONEY_NAME = /(amount|price|cost|total|fee|idr)/i;
/** Zod ctors that declare a float format outright (zod 4.4.3). */
const FLOAT_CTORS = new Set(['float32', 'float64']);

/**
 * Resolve `<root>.<name>()` and `<root>.coerce.<name>()` to `<name>`; anything else → null.
 * `zodRoots` is the set of local identifiers bound to the zod namespace (see below).
 */
function zodCtorName(callee, zodRoots) {
  if (callee.type !== 'MemberExpression' || callee.computed) return null;
  if (callee.property.type !== 'Identifier') return null;
  const obj = callee.object;
  if (obj.type === 'Identifier' && zodRoots.has(obj.name)) return callee.property.name;
  if (
    obj.type === 'MemberExpression' &&
    !obj.computed &&
    obj.object.type === 'Identifier' &&
    zodRoots.has(obj.object.name) &&
    obj.property.type === 'Identifier' &&
    obj.property.name === 'coerce'
  ) {
    return callee.property.name;
  }
  return null;
}

/**
 * Name of the object property this schema expression is assigned to, walking past any
 * chained calls (`lat: z.float64().nullable()` → `lat`). Null when it isn't a property value.
 */
function enclosingPropertyName(node) {
  let current = node;
  while (
    current.parent &&
    ((current.parent.type === 'MemberExpression' && current.parent.object === current) ||
      (current.parent.type === 'CallExpression' && current.parent.callee === current))
  ) {
    current = current.parent;
  }
  const parent = current.parent;
  if (!parent || parent.type !== 'Property' || parent.value !== current || parent.computed) {
    return null;
  }
  if (parent.key.type === 'Identifier') return parent.key.name;
  if (parent.key.type === 'Literal' && typeof parent.key.value === 'string')
    return parent.key.value;
  return null;
}

/** Walk a method chain upwards from a call and collect chained method names. */
function chainHasInt(zNumberCall) {
  let current = zNumberCall;
  while (
    current.parent &&
    current.parent.type === 'MemberExpression' &&
    current.parent.object === current &&
    !current.parent.computed &&
    current.parent.parent &&
    current.parent.parent.type === 'CallExpression' &&
    current.parent.parent.callee === current.parent
  ) {
    if (current.parent.property.type === 'Identifier' && current.parent.property.name === 'int') {
      return true;
    }
    current = current.parent.parent;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Money is integer IDR — z.number() must chain .int(); float operations on money identifiers are forbidden (ai-docs/05-operation-log.md §3)',
    },
    messages: {
      zNumberWithoutInt:
        'z.number() without .int() in a schema file — money and counts are integers (05-operation-log §3). Chain .int() or use a non-numeric type.',
      zFloatConstructor:
        '{{ctor}}() in a schema file — money is integer IDR, floats never (05-operation-log §3). Use z.number().int() / z.int().',
      floatOnMoney:
        "Float operation on money-named identifier '{{name}}' — money is integer IDR, floats never (05-operation-log §3).",
      nonIntegerLiteral:
        'Non-integer numeric literal in a schema file — money is integer IDR (05-operation-log §3).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          numericLiterals: { type: 'boolean' },
          allowFloatFiles: { type: 'array', items: { type: 'string' } },
          allowFloatProps: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    const numericLiterals = options.numericLiterals ?? true;
    const allowFloatFiles = options.allowFloatFiles ?? [];
    const allowFloatProps = options.allowFloatProps ?? [];
    const filename = String(context.filename ?? '').replace(/\\/g, '/');
    // Carve-out dimension 1: the file. Empty allowlist ⇒ no file is exempt (safe default).
    const fileAllowsFloat = allowFloatFiles.some((suffix) => filename.endsWith(suffix));

    // Local identifiers standing for the zod namespace. `z` is always assumed (the repo
    // convention, and schema snippets are often linted without their import). An aliased
    // import — `import { z as zod } from 'zod'` — adds its local name, so `zod.float64()`
    // is caught too: the shared config's no-restricted-imports ban stops named and
    // namespace zod imports but CANNOT stop that alias (the imported name is `z`, which is
    // allowed), so the rule closes it here rather than assuming it away.
    const zodRoots = new Set(['z']);

    /** Float ctor is exempt only in an allowlisted file AND on an allowlisted property. */
    function isCarvedOut(node) {
      if (!fileAllowsFloat) return false;
      const prop = enclosingPropertyName(node);
      return prop !== null && allowFloatProps.includes(prop);
    }

    return {
      // Runs before CallExpression: ESLint traverses the program in source order and imports
      // are hoisted to the top of the file, so zodRoots is populated before any call is seen.
      ImportDeclaration(node) {
        if (node.source.value !== 'zod') return;
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportNamespaceSpecifier') {
            // `import * as zod from 'zod'` — the whole namespace
            zodRoots.add(spec.local.name);
          } else if (
            spec.type === 'ImportSpecifier' &&
            spec.imported.type === 'Identifier' &&
            spec.imported.name === 'z'
          ) {
            // `import { z as zod } from 'zod'` — local name stands for the namespace
            zodRoots.add(spec.local.name);
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        const ctor = zodCtorName(callee, zodRoots);
        // z.number() / z.coerce.number() without a chained .int()
        if (ctor === 'number') {
          if (!chainHasInt(node)) {
            context.report({ node, messageId: 'zNumberWithoutInt' });
          }
        }
        // z.float64() / z.float32() — a declared float format; always wrong for money
        if (ctor !== null && FLOAT_CTORS.has(ctor) && !isCarvedOut(node)) {
          context.report({ node, messageId: 'zFloatConstructor', data: { ctor: `z.${ctor}` } });
        }
        // parseFloat(amount) / Number.parseFloat(amount)
        const isParseFloat =
          (callee.type === 'Identifier' && callee.name === 'parseFloat') ||
          (callee.type === 'MemberExpression' &&
            !callee.computed &&
            callee.object.type === 'Identifier' &&
            callee.object.name === 'Number' &&
            callee.property.type === 'Identifier' &&
            callee.property.name === 'parseFloat');
        if (isParseFloat) {
          for (const arg of node.arguments) {
            if (arg.type === 'Identifier' && MONEY_NAME.test(arg.name)) {
              context.report({ node, messageId: 'floatOnMoney', data: { name: arg.name } });
            }
          }
        }
        // amount.toFixed(2)
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'toFixed' &&
          callee.object.type === 'Identifier' &&
          MONEY_NAME.test(callee.object.name)
        ) {
          context.report({ node, messageId: 'floatOnMoney', data: { name: callee.object.name } });
        }
      },
      Literal(node) {
        if (numericLiterals && typeof node.value === 'number' && !Number.isInteger(node.value)) {
          context.report({ node, messageId: 'nonIntegerLiteral' });
        }
      },
    };
  },
};
