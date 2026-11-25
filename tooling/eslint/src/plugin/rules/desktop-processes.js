// The counter PC runs three processes, and each folder of apps/desktop/src is one of them:
// renderer (the window, React DOM), main (Electron's window and OS glue) and core (the offline
// engine: SQLite, sync, signing). They talk only through the protocol files below, which import
// nothing at runtime. The window stays smooth because heavy engine code cannot reach it, and main
// stays thin so a slow sync never freezes the window frame.
import path from 'node:path';

const PROTOCOL = new Set([
  'core/api',
  'main/rpc',
  'main/bridge',
  'main/process-api',
  'main/main-port',
]);

const DENIED = {
  renderer: [
    /^electron($|\/)/,
    /^node:/,
    /^@bolusi\/db-client($|\/)/,
    /^better-sqlite3$/,
    /^kysely($|\/)/,
    /^@noble\//,
    /^hash-wasm$/,
  ],
  main: [
    /^react($|-dom|\/)/,
    /^@bolusi\/(ui|ui-web|modules|device|db-client)($|\/)/,
    /^kysely($|\/)/,
  ],
  core: [
    /^react($|-dom|\/)/,
    /^@bolusi\/(ui|ui-web)($|\/)/,
    /^@bolusi\/modules\/.*\/(desktop|screens)($|\/)/,
    /^lucide-react$/,
  ],
};

const WHY = {
  renderer: 'the window must stay smooth, so engine and Node code stay in core',
  main: 'main only drives windows and the OS, so a slow sync never freezes the window',
  core: 'the offline engine has no UI',
};

function processOf(filename) {
  const file = filename.split(path.sep).join('/');
  const match = /\/apps\/desktop\/src\/(renderer|main|core)\/(.+)$/.exec(file);
  if (!match || /\.test\.[cm]?[jt]sx?$/.test(file)) return null;
  return { name: match[1], file };
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Keep each counter PC process to its own code and packages.' },
    schema: [],
    messages: {
      deniedPackage: "'{{source}}' does not belong in the PC's {{process}} process: {{why}}.",
      otherProcess:
        "'{{source}}' is in the PC's {{target}} process. The {{process}} process reaches it only through the protocol files (core/api, main/rpc, main/bridge, main/process-api, main/main-port).",
    },
  },
  create(context) {
    const own = processOf(context.filename);
    if (!own) return {};

    function check(node, source) {
      if (DENIED[own.name].some((re) => re.test(source))) {
        context.report({
          node,
          messageId: 'deniedPackage',
          data: { source, process: own.name, why: WHY[own.name] },
        });
        return;
      }
      if (!source.startsWith('.')) return;
      const target = path
        .resolve(path.dirname(own.file), source)
        .split(path.sep)
        .join('/')
        .replace(/\.[cm]?[jt]sx?$/, '');
      const match = /\/apps\/desktop\/src\/(renderer|main|core)\/(.+)$/.exec(target);
      if (!match || match[1] === own.name || PROTOCOL.has(`${match[1]}/${match[2]}`)) return;
      context.report({
        node,
        messageId: 'otherProcess',
        data: { source, target: match[1], process: own.name },
      });
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
