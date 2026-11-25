import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, it } from 'vitest';

import rule from './react-only-in-tsx.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'react-only-in-tsx-'));
const src = path.join(root, 'packages/modules/src');
for (const file of ['money/hooks.tsx', 'money/kas.ts', 'money/screens/index.ts', 'kit/index.tsx']) {
  fs.mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
  fs.writeFileSync(path.join(src, file), '');
}
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const at = (file) => path.join(src, file);
const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('react-only-in-tsx', rule, {
  valid: [
    { filename: at('money/index.ts'), code: "export { kasDay } from './kas.js';" },
    { filename: at('money/index.ts'), code: "import { z } from 'zod';" },
    { filename: at('money/hooks.tsx'), code: "import { useState } from 'react';" },
    { filename: at('money/hooks.tsx'), code: "import { Text } from '@bolusi/ui';" },
    { filename: at('money/screens/index.ts'), code: "export { useKas } from '../hooks.js';" },
    { filename: at('money/desktop/index.ts'), code: "import { useState } from 'react';" },
    { filename: at('money/kas.test.ts'), code: "import { render } from '@bolusi/ui';" },
    { filename: path.join(root, 'apps/server/src/a.ts'), code: "import 'react';" },
  ],
  invalid: [
    {
      filename: at('money/kas.ts'),
      code: "import { useMemo } from 'react';",
      errors: [{ messageId: 'uiPackage' }],
    },
    {
      filename: at('money/kas.ts'),
      code: "import type { ReactNode } from 'react';",
      errors: [{ messageId: 'uiPackage' }],
    },
    {
      filename: at('money/kas.ts'),
      code: "import type { BannerCause } from '@bolusi/ui';",
      errors: [{ messageId: 'uiPackage' }],
    },
    {
      filename: at('money/index.ts'),
      code: "export { forgetShownQrs } from './hooks.js';",
      errors: [{ messageId: 'uiFile' }],
    },
    {
      filename: at('money/index.ts'),
      code: "import type { Kas } from './hooks.js';",
      errors: [{ messageId: 'uiFile' }],
    },
    {
      filename: at('money/index.ts'),
      code: "export * from '../kit/index.js';",
      errors: [{ messageId: 'uiFile' }],
    },
    {
      filename: at('money/index.ts'),
      code: "import type { KasProps } from './screens/index.js';",
      errors: [{ messageId: 'uiFile' }],
    },
    {
      filename: at('money/index.ts'),
      code: "const hooks = await import('./hooks.js');",
      errors: [{ messageId: 'uiFile' }],
    },
  ],
});
