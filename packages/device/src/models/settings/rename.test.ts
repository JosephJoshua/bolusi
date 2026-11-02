import { describe, expect, test } from 'vitest';

import { deviceNameProblem } from './rename.js';

describe('deviceNameProblem', () => {
  test('takes a trimmed name of 1 to 64 characters', () => {
    expect(deviceNameProblem('  Kasir depan ')).toBeNull();
    expect(deviceNameProblem('x'.repeat(64))).toBeNull();
    expect(deviceNameProblem('   ')).toBe('nameMissing');
    expect(deviceNameProblem('x'.repeat(65))).toBe('nameTooLong');
  });
});
