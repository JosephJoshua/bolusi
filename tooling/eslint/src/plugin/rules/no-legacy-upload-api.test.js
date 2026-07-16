import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './no-legacy-upload-api.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('no-legacy-upload-api', rule, {
  valid: [
    // The SDK 57 APIs 06 §5.5 mandates: File/Paths/Directory, and FileHandle offset+readBytes.
    { code: "import { File, Paths } from 'expo-file-system';" },
    { code: "import { File, Directory, Paths } from 'expo-file-system';" },
    { code: "import * as FS from 'expo-file-system'; const h = new FS.File(p).open();" },
    { code: "import * as FS from 'expo-file-system'; h.readBytes(262144);" },
    // A same-named method on something that is NOT expo-file-system is not our business — the rule
    // must not become a global ban on the word `uploadAsync`.
    { code: "import { uploadAsync } from 'some-other-sdk';" },
    { code: 'await s3.uploadAsync(key, body);' },
    { code: 'const uploadAsync = () => {}; uploadAsync();' },
    // Our own transport is the sanctioned path.
    { code: "import { MediaTransportPort } from '@bolusi/core';" },
  ],
  invalid: [
    // The exact form the module-specifier rule cannot see: a NAMED import from the PERMITTED main
    // entry. This resolves, type-checks, builds — and throws on a technician's phone (06 §5.5).
    {
      code: "import { uploadAsync } from 'expo-file-system';",
      errors: [{ messageId: 'legacyUploadImport' }],
    },
    {
      code: "import { createUploadTask } from 'expo-file-system';",
      errors: [{ messageId: 'legacyUploadImport' }],
    },
    {
      code: "import { File, uploadAsync } from 'expo-file-system';",
      errors: [{ messageId: 'legacyUploadImport' }],
    },
    {
      code: "import { uploadAsync, createUploadTask } from 'expo-file-system';",
      errors: [{ messageId: 'legacyUploadImport' }, { messageId: 'legacyUploadImport' }],
    },
    // Renamed on import — still the same throwing binding.
    {
      code: "import { uploadAsync as upload } from 'expo-file-system';",
      errors: [{ messageId: 'legacyUploadImport' }],
    },
    // Via a namespace import — the form a named-specifier check alone misses entirely.
    {
      code: "import * as FS from 'expo-file-system'; await FS.uploadAsync(url, path);",
      errors: [{ messageId: 'legacyUploadMember' }],
    },
    {
      code: "import * as FileSystem from 'expo-file-system'; const t = FileSystem.createUploadTask(url, path);",
      errors: [{ messageId: 'legacyUploadMember' }],
    },
    // A subpath of the same package.
    {
      code: "import { uploadAsync } from 'expo-file-system/legacy';",
      errors: [{ messageId: 'legacyUploadImport' }],
    },
  ],
});
