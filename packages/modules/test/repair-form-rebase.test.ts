import { describe, expect, it } from 'vitest';

import { rebaseForm } from '../src/repair/form-rebase.js';

describe('an open form when the saved settings change', () => {
  const before = { name: 'Bolusi', address: 'Jl. Yos Sudarso', phone: '0811' };

  it('takes the new value of every untouched field and keeps every edit', () => {
    const form = { ...before, phone: '0822' };
    const after = { ...before, address: 'Jl. Ahmad Yani' };
    expect(rebaseForm(form, before, after)).toEqual({
      name: 'Bolusi',
      address: 'Jl. Ahmad Yani',
      phone: '0822',
    });
  });

  it('is the new settings when nothing was edited', () => {
    const after = { ...before, name: 'Bolusi Sorong' };
    expect(rebaseForm(before, before, after)).toEqual(after);
  });

  it('compares fields the way the form does', () => {
    const form = { ...before, name: 'Bolusi ' };
    const after = { ...before, name: 'Bolusi Sorong' };
    const trimmed = (_key: string, a: string, b: string): boolean => a.trim() === b.trim();
    expect(rebaseForm(form, before, after, trimmed).name).toBe('Bolusi Sorong');
  });
});
