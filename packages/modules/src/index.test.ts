import { expect, test } from 'vitest';

import { PACKAGE_NAME } from './index.js';

test('@bolusi/modules shell wires into the root vitest projects config', () => {
  expect(PACKAGE_NAME).toBe('@bolusi/modules');
});
