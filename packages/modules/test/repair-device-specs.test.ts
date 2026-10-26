// What the screens make of a catalog spec sheet: shop-style memory variants, colour choices, and
// which rows each viewer sees.
import { expect, test } from 'vitest';

import { colourChoices, memoryVariants, specFacts } from '../src/repair/device-specs.js';

test('memory variants read the way shops write them, RAM first', () => {
  expect(memoryVariants('128GB 8GB RAM, 256GB 8GB RAM, 256GB 12GB RAM')).toEqual([
    '8/128GB',
    '8/256GB',
    '12/256GB',
  ]);
  expect(memoryVariants('1TB 12GB RAM, 16GB 512MB RAM')).toEqual(['12/1TB', '512MB/16GB']);
  // Another shape is kept as written, and a repeat is shown once.
  expect(memoryVariants('32GB eMMC 5.1, 32GB eMMC 5.1')).toEqual(['32GB eMMC 5.1']);
  expect(memoryVariants(undefined)).toEqual([]);
});

test('colour choices are the listed colours, once each, all of them (the row scrolls)', () => {
  expect(colourChoices('Awesome Navy, Awesome Lilac,  , Awesome Navy')).toEqual([
    'Awesome Navy',
    'Awesome Lilac',
  ]);
  expect(colourChoices(Array.from({ length: 12 }, (_, i) => `C${i}`).join(', '))).toHaveLength(12);
  expect(colourChoices(undefined)).toEqual([]);
});

const A55 = {
  displayType: 'Super AMOLED, 120Hz',
  displaySize: '6.6 inches',
  chipset: 'Exynos 1480 (4 nm)',
  internalMemory: '128GB 8GB RAM, 256GB 8GB RAM',
  cardSlot: 'No',
  battery: 'Li-Ion 5000 mAh',
  charging: '25W wired',
  usb: 'USB Type-C 2.0',
  sim: 'Nano-SIM + eSIM',
  os: 'Android 14',
  colors: 'Awesome Navy',
};

test('the counter sees memory variants; a technician also sees the inside of the phone', () => {
  expect(specFacts(A55, false)).toEqual([{ key: 'memory', value: '8/128GB · 8/256GB' }]);
  expect(specFacts(A55, true)).toEqual([
    { key: 'memory', value: '8/128GB · 8/256GB' },
    { key: 'screen', value: '6.6 inci, Super AMOLED, 120Hz' },
    { key: 'chipset', value: 'Exynos 1480 (4 nm)' },
    { key: 'battery', value: 'Li-Ion 5000 mAh, 25W wired' },
    { key: 'port', value: 'USB Type-C 2.0' },
    { key: 'sim', value: 'Nano-SIM + eSIM' },
    { key: 'cardSlot', value: 'No' },
    { key: 'os', value: 'Android 14' },
  ]);
  expect(specFacts({ chipset: 'Helio G85' }, false)).toEqual([]);
  expect(specFacts({}, true)).toEqual([]);
});
