import { describe, expect, test } from 'vitest';

import { InvalidationBus } from './invalidation.js';

describe('InvalidationBus.subscribeTables', () => {
  test('fires once per emission touching any watched table, never for others', () => {
    const bus = new InvalidationBus();
    let fires = 0;
    const unsubscribe = bus.subscribeTables(['tickets', 'lines'], () => {
      fires += 1;
    });
    bus.emit(new Set(['tickets', 'lines']));
    bus.emit(new Set(['lines']));
    bus.emit(new Set(['notes']));
    expect(fires).toBe(2);
    unsubscribe();
    bus.emit(new Set(['tickets']));
    expect(fires).toBe(2);
  });
});
