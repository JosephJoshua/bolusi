import { describe, expect, it } from 'vitest';

import { findMediaInput } from './webcam.js';

const LISTED = [
  { deviceId: 'a', label: 'Integrated Camera' },
  { deviceId: 'b', label: 'Logitech C270' },
];

describe('findMediaInput', () => {
  it('finds the chosen input by id, then by name when Windows gave it a new id', () => {
    expect(findMediaInput(LISTED, { deviceId: 'b', label: 'old name' })?.deviceId).toBe('b');
    expect(findMediaInput(LISTED, { deviceId: 'gone', label: 'Logitech C270' })?.deviceId).toBe(
      'b',
    );
  });

  it('finds nothing for no choice, an unplugged one, or a nameless one under a new id', () => {
    expect(findMediaInput(LISTED, null)).toBeUndefined();
    expect(findMediaInput(LISTED, { deviceId: 'gone', label: 'Other' })).toBeUndefined();
    expect(
      findMediaInput([...LISTED, { deviceId: 'c', label: '' }], { deviceId: 'x', label: '' }),
    ).toBeUndefined();
  });
});
