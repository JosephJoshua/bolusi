import { expect, test } from 'vitest';

import { PACKAGE_NAME } from './index.js';

test('@bolusi/test-support shell wires into the root vitest projects config', () => {
  expect(PACKAGE_NAME).toBe('@bolusi/test-support');
});
