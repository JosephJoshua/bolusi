import { expect, test } from 'vitest';

import { PACKAGE_NAME } from './index.js';

test('@bolusi/db-client shell wires into the root vitest projects config', () => {
  expect(PACKAGE_NAME).toBe('@bolusi/db-client');
});
