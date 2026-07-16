// bolusi/no-legacy-upload-api — the legacy expo-file-system upload APIs are never used
// (06-media-pipeline §5.5; 08 §2.2).
//
// 06 §5.5, verbatim: "The legacy upload APIs (`uploadAsync`, `createUploadTask`) are **never
// used**: main-entry re-exports throw at runtime in SDK 57, and no Expo API offers resumable
// upload (research-verified)."
//
// WHY A SEPARATE RULE FROM `bolusi/boundaries`. That rule bans MODULE SPECIFIERS and already bans
// `expo-file-system/legacy` outright. It cannot see these, because they are NAMED IMPORTS from the
// permitted main entry — `import { uploadAsync } from 'expo-file-system'` passes every existing
// check. This is the gap between "the legacy module is banned" and "the legacy API is banned", and
// it matters precisely because the main entry still EXPORTS these names: the import resolves, tsc
// is satisfied, the build succeeds, and the call throws on a technician's phone at the moment they
// try to upload evidence. A well-typed no-op's louder cousin — it type-checks and cannot work
// (CLAUDE.md §2.11: "typed and compiling" is not "running on the target").
//
// The positive rule this protects: uploads go through our hand-rolled chunked protocol
// (api/03-media §1 — "No Expo-native resumable upload exists (SDK 57, research-verified), so the
// protocol is ours"), reading byte ranges via `File.open()` → FileHandle offset/readBytes so the
// file is never loaded whole into memory on a 2 GB device (06 §5.5).

const LEGACY_UPLOAD_NAMES = new Set(['uploadAsync', 'createUploadTask']);
const FILE_SYSTEM_MODULE = /^expo-file-system(\/|$)/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'The legacy expo-file-system upload APIs (uploadAsync, createUploadTask) throw at runtime in SDK 57 and offer no resumable upload — use the chunked MediaTransportPort (ai-docs/06-media-pipeline.md §5.5)',
    },
    messages: {
      legacyUploadImport:
        "'{{name}}' is a legacy expo-file-system upload API — its main-entry re-export THROWS at runtime in SDK 57, and it offers no resumable upload (06-media-pipeline §5.5; 08 §2.2). Uploads use the chunked init/PUT/status/complete protocol (api/03-media §1) with FileHandle offset+readBytes.",
      legacyUploadMember:
        "'{{name}}' is a legacy expo-file-system upload API and throws at runtime in SDK 57 (06-media-pipeline §5.5). Use the chunked MediaTransportPort (api/03-media §1).",
    },
    schema: [],
  },
  create(context) {
    /** Namespace bindings for expo-file-system: `import * as FS from 'expo-file-system'`. */
    const namespaces = new Set();

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== 'string' || !FILE_SYSTEM_MODULE.test(source)) return;
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportNamespaceSpecifier') {
            namespaces.add(spec.local.name);
            continue;
          }
          if (spec.type !== 'ImportSpecifier') continue;
          const imported =
            spec.imported.type === 'Identifier' ? spec.imported.name : String(spec.imported.value);
          if (LEGACY_UPLOAD_NAMES.has(imported)) {
            context.report({
              node: spec,
              messageId: 'legacyUploadImport',
              data: { name: imported },
            });
          }
        }
      },
      // `FS.uploadAsync(...)` / `FileSystem.createUploadTask(...)` via a namespace import — the
      // form a named-import check alone would miss entirely.
      MemberExpression(node) {
        if (node.computed) return;
        if (node.object.type !== 'Identifier' || !namespaces.has(node.object.name)) return;
        if (node.property.type !== 'Identifier') return;
        if (!LEGACY_UPLOAD_NAMES.has(node.property.name)) return;
        context.report({
          node,
          messageId: 'legacyUploadMember',
          data: { name: node.property.name },
        });
      },
    };
  },
};
