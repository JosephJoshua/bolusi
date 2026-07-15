// The blank-screen guard, at the RENDER boundary.
//
// `zone.test.ts` proves the GATE is total (every input maps to a zone). This proves the other half:
// every zone the gate can produce actually renders something. Together they close this task's
// acceptance — "invalid-transition rendering asserted: no state maps to a blank screen" — which
// neither half establishes alone: a total gate feeding a renderer with a missing arm is still a
// blank screen.
import React from 'react';
import { describe, expect, test } from 'vitest';

import { renderZone, type ZoneRenderers } from './RootNavigator.js';
import { resolveZone, type DeviceStatus, type ShellRoute, type Zone } from './zone.js';

/** Stub renderers that record which arm ran, so a wrong-arm bug is visible, not just non-blank. */
function renderers(seen: string[]): ZoneRenderers {
  return {
    enrollment: (revoked) => {
      seen.push(`enrollment:${revoked}`);
      return React.createElement('enrollment');
    },
    switcher: (zone) => {
      seen.push(`switcher:${zone.mode}`);
      return React.createElement('switcher');
    },
    pin: (zone) => {
      seen.push(`pin:${zone.userId}`);
      return React.createElement('pin');
    },
    shell: (zone) => {
      seen.push(`shell:${zone.route}`);
      return React.createElement('shell');
    },
  };
}

describe('every zone renders — no state maps to a blank screen', () => {
  test.each<[string, Zone, string]>([
    ['unenrolled', { kind: 'enrollment', revoked: false }, 'enrollment:false'],
    ['revoked', { kind: 'enrollment', revoked: true }, 'enrollment:true'],
    ['lock switcher', { kind: 'switcher', mode: 'lock' }, 'switcher:lock'],
    ['voluntary switcher', { kind: 'switcher', mode: 'choose' }, 'switcher:choose'],
    ['pin', { kind: 'pin', userId: 'u-1', mode: 'lock' }, 'pin:u-1'],
    ['shell home', { kind: 'shell', route: 'home' }, 'shell:home'],
    ['shell sync', { kind: 'shell', route: 'syncStatus' }, 'shell:syncStatus'],
    ['shell settings', { kind: 'shell', route: 'settings' }, 'shell:settings'],
  ])('%s renders its own arm', (_label, zone, expected) => {
    const seen: string[] = [];
    expect(renderZone(zone, renderers(seen))).toBeDefined();
    expect(seen).toEqual([expected]);
  });

  test('every zone the GATE can produce reaches a renderer (the two halves, joined)', () => {
    // Drive the real gate across its whole input space and render each result. This is what catches
    // a zone that `resolveZone` can emit but `renderZone` has no arm for — the seam between the two
    // total functions, which is exactly where a blank screen would live.
    const devices: DeviceStatus[] = ['unenrolled', 'active', 'revoked'];
    const routes: ShellRoute[] = ['home', 'syncStatus', 'settings'];
    const seen: string[] = [];
    let count = 0;

    for (const device of devices)
      for (const session of [null, { userId: 'user-a' }])
        for (const locked of [true, false])
          for (const pinFor of [null, 'user-b'])
            for (const route of routes) {
              const zone = resolveZone({ device, session, locked, pinFor, route });
              expect(renderZone(zone, renderers(seen))).toBeDefined();
              count += 1;
            }

    // The sweep's own denominator (T-14): a zero-iteration loop would otherwise report green.
    expect(count).toBe(devices.length * 2 * 2 * 2 * routes.length);
    expect(seen).toHaveLength(count);
    // And every arm was genuinely exercised — not just the easy ones.
    expect(new Set(seen.map((entry) => entry.split(':')[0])).size).toBe(4);
  });

  test('a zone smuggled past the type system throws rather than rendering nothing', () => {
    // The runtime belt to the compile-time braces. A cast, a bad parse, or a future member added
    // without an arm must fail loudly — a silent blank screen on a shared shop terminal is
    // indistinguishable from a crashed app, and the staff response to both is a reboot.
    const bogus = { kind: 'notAZone' } as unknown as Zone;
    expect(() => renderZone(bogus, renderers([]))).toThrow(/Unhandled zone/);
  });
});
