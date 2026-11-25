// In packages/modules the file extension says where code may run. A `.ts` file is platform-free:
// the server and the PC's background process load it, so it never reaches React, a UI package, a
// `.tsx` file or a screens/desktop folder, not even for a type. Hooks and components live in
// `.tsx`. Because a `.ts` file can only import other `.ts` files, everything the server loads from
// a module stays free of React without anyone tracing the import graph.
import fs from 'node:fs';
import path from 'node:path';

const UI_PACKAGES =
  /^(?:react|react-dom|react-native(?:-[^/]+)?|@bolusi\/ui|@bolusi\/ui-web)(?:\/|$)/;
const UI_FOLDER = /\/(?:screens|desktop)(?:\/|$)/;

function isPlatformFreeFile(filename) {
  const file = filename.split(path.sep).join('/');
  return (
    /\/packages\/modules\/src\//.test(file) &&
    file.endsWith('.ts') &&
    !file.endsWith('.d.ts') &&
    !/\.test\.ts$/.test(file) &&
    !UI_FOLDER.test(file.slice(file.indexOf('/packages/modules/src/')))
  );
}

/** The `.tsx` file a relative specifier lands on, if it lands on one. */
function tsxTarget(filename, source) {
  const base = path.resolve(path.dirname(filename), source).replace(/\.js$/, '');
  for (const candidate of [`${base}.tsx`, path.join(base, 'index.tsx')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A .ts file in packages/modules is platform-free: React, UI packages and .tsx files are off limits.',
    },
    schema: [],
    messages: {
      uiPackage:
        "'{{source}}' is UI. This .ts file is loaded by the server and the PC core, so it stays free of React. Put hooks and components in a .tsx file, and keep what both sides need here.",
      uiFile:
        "'{{source}}' is a UI file (.tsx, screens/ or desktop/). This .ts file is loaded by the server and the PC core, so it cannot import it, not even a type. Move the shared part into a .ts file, or make this file .tsx if it is UI itself.",
    },
  },
  create(context) {
    const filename = context.filename;
    if (!isPlatformFreeFile(filename)) return {};

    function check(node, source) {
      if (UI_PACKAGES.test(source)) {
        context.report({ node, messageId: 'uiPackage', data: { source } });
        return;
      }
      if (!source.startsWith('.')) return;
      if (UI_FOLDER.test(source) || tsxTarget(filename, source)) {
        context.report({ node, messageId: 'uiFile', data: { source } });
      }
    }

    const fromSource = (node) => {
      if (node.source && typeof node.source.value === 'string') check(node, node.source.value);
    };
    return {
      ImportDeclaration: fromSource,
      ExportNamedDeclaration: fromSource,
      ExportAllDeclaration: fromSource,
      ImportExpression(node) {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
          check(node, node.source.value);
        }
      },
    };
  },
};
