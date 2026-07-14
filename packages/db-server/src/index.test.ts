import { expect, test } from 'vitest';

import { PACKAGE_NAME } from './index.js';

test('@bolusi/db-server shell wires into the root vitest projects config', () => {
  expect(PACKAGE_NAME).toBe('@bolusi/db-server');
});
