// bolusi/permission-module-prefix — the 02-permissions §2 CI lint:
//
//   "a module manifest may declare permissions only under its own prefix; a command/query may only
//    require a permission declared by its own module (v0 — cross-module permission use is a v1
//    decision)."
//
// WHY A LINT WHEN THE RUNTIME ALREADY CHECKS THIS. It does not check the same thing. Registry
// assembly (02 §3.2 rule 4, packages/core/src/authz/registry.ts) rejects a manifest DECLARING an id
// under someone else's prefix, and rule 3 rejects a command requiring an id that resolves nowhere —
// but a command requiring another module's REAL permission resolves fine and boots happily. That is
// the cross-module use §2 defers to v1, and this rule is the only thing that sees it. The two are
// complements: assembly is the runtime backstop, this is the authoring-time gate.
//
// SHAPE DETECTION. A "module manifest" here is an object literal carrying a string `id` property
// plus at least one of `permissions` / `commands` / `queries`. That is structural rather than
// name-based (`defineModule(...)` is task 11 and may be wrapped, re-exported, or spread), so the
// rule keeps working if the factory is renamed. The cost of the loose shape is that an unrelated
// object with an `id` and a `commands` map could be inspected — harmless: it only reports when a
// `permission` string's prefix disagrees with a sibling `id` string, which is meaningless in any
// other object.
//
// Only LITERAL ids and permission strings are checked. A computed id or a permission built from a
// variable is invisible to a static rule; assembly's rule 4 still catches the declaration half at
// startup, and v0 manifests are literal by convention.

/** The `<module>` part of a `<module>.<action>` id, or null when there is no dot. */
function modulePrefix(permissionId) {
  const dot = permissionId.indexOf('.');
  return dot === -1 ? null : permissionId.slice(0, dot);
}

/** A string-literal property value, or null. */
function literalString(property) {
  if (!property || property.type !== 'Property') return null;
  const { value } = property;
  return value.type === 'Literal' && typeof value.value === 'string' ? value.value : null;
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

/** The static string key of a property (`'notes.create': {...}` or `notes: {...}`), or null. */
function staticKey(property) {
  if (property.type !== 'Property' || property.computed) return null;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
    return property.key.value;
  }
  if (property.key.type === 'Identifier') return property.key.name;
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A module manifest declares permissions only under its own prefix, and its commands/queries require only its own permissions (ai-docs/02-permissions.md §2).',
    },
    messages: {
      declaredPrefix:
        "Module '{{module}}' declares permission '{{permission}}', which belongs to module '{{prefix}}'. A manifest may declare permissions only under its own prefix (02-permissions §2, §3.2 rule 4).",
      requiredPrefix:
        "{{surface}} '{{name}}' in module '{{module}}' requires permission '{{permission}}', owned by module '{{prefix}}'. A command/query may require only its own module's permissions (02-permissions §2 — cross-module permission use is a v1 decision).",
      malformedId:
        "Permission id '{{permission}}' is not '<module>.<action>' (02-permissions §2: /^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$/).",
    },
    schema: [],
  },
  create(context) {
    return {
      ObjectExpression(node) {
        const idProperty = findProperty(node, 'id');
        const moduleId = literalString(idProperty);
        if (moduleId === null) return;

        const permissionsProperty = findProperty(node, 'permissions');
        const commandsProperty = findProperty(node, 'commands');
        const queriesProperty = findProperty(node, 'queries');
        if (!permissionsProperty && !commandsProperty && !queriesProperty) return;

        // 1. Declared permissions must sit under the module's own prefix.
        if (permissionsProperty && permissionsProperty.value.type === 'ObjectExpression') {
          for (const property of permissionsProperty.value.properties) {
            const permission = staticKey(property);
            if (permission === null) continue;
            const prefix = modulePrefix(permission);
            if (prefix === null) {
              context.report({ node: property, messageId: 'malformedId', data: { permission } });
              continue;
            }
            if (prefix !== moduleId) {
              context.report({
                node: property,
                messageId: 'declaredPrefix',
                data: { module: moduleId, permission, prefix },
              });
            }
          }
        }

        // 2. Commands/queries may require only this module's permissions.
        for (const [surface, property] of [
          ['Command', commandsProperty],
          ['Query', queriesProperty],
        ]) {
          if (!property || property.value.type !== 'ObjectExpression') continue;
          for (const entry of property.value.properties) {
            const name = staticKey(entry);
            if (name === null || entry.value.type !== 'ObjectExpression') continue;
            const permissionProperty = findProperty(entry.value, 'permission');
            const permission = literalString(permissionProperty);
            if (permission === null) continue;
            const prefix = modulePrefix(permission);
            if (prefix === null) {
              context.report({
                node: permissionProperty,
                messageId: 'malformedId',
                data: { permission },
              });
              continue;
            }
            if (prefix !== moduleId) {
              context.report({
                node: permissionProperty,
                messageId: 'requiredPrefix',
                data: { surface, name, module: moduleId, permission, prefix },
              });
            }
          }
        }
      },
    };
  },
};
