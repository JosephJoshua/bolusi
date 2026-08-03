// Task 146 item 2 — ICON_GLYPHS was a §2.11 "the comment was the guard" hole: Icon.tsx asserts in
// prose that "every glyph below was verified to exist in the MaterialCommunityIcons glyphmap", but
// nothing checked it — a typo would render an invisible tofu box and no test would red. This resolves
// every semantic role against the REAL installed glyphmap (7448 entries at 15.1.1), so a typo fails
// HERE. Modelled on the T-14 denominator discipline: the glyphmap and the role set are both asserted
// non-trivial, so the check cannot pass vacuously over an empty stub.
// The REAL installed glyphmap — the exact JSON `@expo/vector-icons/build/MaterialCommunityIcons.js`
// feeds to `createIconSet(glyphMap, …)`, so a name that resolves here is one the runtime component
// resolves too. Imported DIRECTLY, not via the component: the ui vitest env aliases the icon module
// to a render double (packages/ui/vitest.config.ts), so the component's static glyphmap is empty in
// this lane — the source JSON is the only real set available, and it is the right thing to check.
import glyphMapJson from '@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialCommunityIcons.json';
import { describe, expect, it } from 'vitest';

import { ICON_GLYPHS } from '../src/components/Icon.js';

const glyphMap = glyphMapJson as Record<string, number>;

describe('ICON_GLYPHS resolves against the real MaterialCommunityIcons glyphmap (task 146 item 2)', () => {
  it('loaded the REAL glyphmap — a large set, not an empty stub (T-14 denominator)', () => {
    expect(glyphMap !== null && typeof glyphMap === 'object').toBe(true);
    // 7448 entries at @expo/vector-icons 15.1.1; a floor well below that catches a stubbed/empty map
    // that would let the resolution below pass while checking nothing.
    expect(Object.keys(glyphMap).length).toBeGreaterThan(7000);
  });

  it('there is a non-trivial set of roles to check (T-14 denominator)', () => {
    expect(Object.keys(ICON_GLYPHS).length).toBeGreaterThanOrEqual(18);
  });

  it('every semantic role maps to a glyph that EXISTS in the glyphmap — a typo renders tofu', () => {
    const missing = Object.entries(ICON_GLYPHS).filter(([, glyph]) => !(glyph in glyphMap));
    // Named list, not a boolean: the failure points at the offending role(s) to fix.
    expect(missing.map(([role, glyph]) => `${role} -> '${glyph}'`)).toEqual([]);
  });
});
