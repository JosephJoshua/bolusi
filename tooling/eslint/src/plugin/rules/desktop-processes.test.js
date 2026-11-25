import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';

import rule from './desktop-processes.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const at = (file) => `/repo/apps/desktop/src/${file}`;
const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('desktop-processes', rule, {
  valid: [
    { filename: at('renderer/App.tsx'), code: "import { useState } from 'react';" },
    { filename: at('renderer/App.tsx'), code: "import { CORE_EVENTS } from '../core/api.js';" },
    { filename: at('renderer/App.tsx'), code: "import { connect } from '../main/rpc.js';" },
    {
      filename: at('renderer/App.tsx'),
      code: "import type { DesktopBridge } from '../main/bridge.js';",
    },
    { filename: at('renderer/settings/Staff.tsx'), code: "import { tn } from '../i18n.js';" },
    { filename: at('main/main.ts'), code: "import { app } from 'electron';" },
    { filename: at('main/main.ts'), code: "import fs from 'node:fs';" },
    { filename: at('core/entry.ts'), code: "import { serve } from '../main/rpc.js';" },
    { filename: at('core/host.ts'), code: "import { openDb } from '@bolusi/db-client';" },
    { filename: at('core/host.ts'), code: "import { QrisError } from '@bolusi/modules/money';" },
    {
      filename: '/repo/apps/desktop/test/core.test.ts',
      code: "import { app } from '../src/core/host.js';",
    },
  ],
  invalid: [
    {
      filename: at('renderer/App.tsx'),
      code: "import { ipcRenderer } from 'electron';",
      errors: [{ messageId: 'deniedPackage' }],
    },
    {
      filename: at('renderer/App.tsx'),
      code: "import fs from 'node:fs';",
      errors: [{ messageId: 'deniedPackage' }],
    },
    {
      filename: at('renderer/App.tsx'),
      code: "import { openDb } from '@bolusi/db-client';",
      errors: [{ messageId: 'deniedPackage' }],
    },
    {
      filename: at('renderer/App.tsx'),
      code: "import { startCore } from '../core/host.js';",
      errors: [{ messageId: 'otherProcess' }],
    },
    {
      filename: at('renderer/App.tsx'),
      code: "import type { Settings } from '../main/device-settings.js';",
      errors: [{ messageId: 'otherProcess' }],
    },
    {
      filename: at('main/main.ts'),
      code: "import { createDevice } from '@bolusi/device';",
      errors: [{ messageId: 'deniedPackage' }],
    },
    {
      filename: at('main/main.ts'),
      code: "import { CoreHost } from '../core/host.js';",
      errors: [{ messageId: 'otherProcess' }],
    },
    {
      filename: at('main/main.ts'),
      code: "import { App } from '../renderer/App.js';",
      errors: [{ messageId: 'otherProcess' }],
    },
    {
      filename: at('core/host.ts'),
      code: "import { useState } from 'react';",
      errors: [{ messageId: 'deniedPackage' }],
    },
    {
      filename: at('core/host.ts'),
      code: "import { KasPage } from '@bolusi/modules/money/desktop';",
      errors: [{ messageId: 'deniedPackage' }],
    },
    {
      filename: at('core/host.ts'),
      code: "import { tn } from '../renderer/i18n.js';",
      errors: [{ messageId: 'otherProcess' }],
    },
  ],
});
