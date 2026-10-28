import { describe, expect, it } from 'vitest';

import { opensExternally } from '../src/main/external-links.js';

describe('links the counter app opens outside itself', () => {
  it('opens a WhatsApp message link', () => {
    expect(opensExternally('https://wa.me/6281234567890?text=Halo')).toBe(true);
  });

  it('keeps every other link inside the locked-down window', () => {
    for (const url of [
      'http://wa.me/6281234567890',
      'https://wa.me.example.com/6281234567890',
      'https://user@wa.me/6281234567890',
      'https://wa.me:8443/6281234567890',
      'https://example.com/',
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(opensExternally(url), url).toBe(false);
    }
  });
});
