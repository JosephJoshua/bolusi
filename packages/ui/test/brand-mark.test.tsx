// The phone's logo draws from the same geometry as the PC's, and its parts stack on one canvas so the
// opening intro can move each on its own without them drifting apart.
import { describe, expect, test } from 'vitest';

import { BrandMark, brandMarkWidth } from '../src/components/BrandMark.js';
import { brandMark, brandTones } from '../src/brand.js';
import { render } from './render.js';

const drawn = (r: ReturnType<typeof render>, type: string) =>
  r.container.queryAll((node) => node.type === type);

describe('BrandMark', () => {
  test('keeps the mark proportions at any height', () => {
    expect(brandMarkWidth(400)).toBe(brandMark.viewBox.width);
    const r = render(<BrandMark size={48} testID="m" />);
    expect(r.get('m').props['width']).toBeCloseTo(48 * (324 / 400));
  });

  test('draws ring, stem and disc by default, the disc in gold', () => {
    const r = render(<BrandMark size={48} />);
    expect(drawn(r, 'Circle')).toHaveLength(2);
    expect(drawn(r, 'Path')).toHaveLength(1);
    expect(drawn(r, 'Circle')[1]!.props['fill']).toBe(brandTones.light.disc);
  });

  test('draws only the asked parts on the full canvas', () => {
    const r = render(<BrandMark size={48} parts={['disc']} testID="m" />);
    expect(drawn(r, 'Path')).toHaveLength(0);
    expect(drawn(r, 'Circle')).toHaveLength(1);
    expect(r.get('m').props['viewBox']).toBe('92 58 324 400');
  });

  test('is decoration unless it is given a name', () => {
    expect(render(<BrandMark size={24} testID="m" />).get('m').props['accessible']).toBe(false);
    const named = render(<BrandMark size={24} label="Bolusi" testID="m" />).get('m');
    expect(named.props['accessibilityLabel']).toBe('Bolusi');
  });
});
