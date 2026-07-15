/**
 * The root — turns a `Zone` (zone.ts) into a screen.
 *
 * WHY THE SWITCH IS EXHAUSTIVE AND NOT A LOOKUP MAP. `assertNever` in the default arm makes a new
 * `Zone` member a COMPILE error rather than a blank screen. "No state maps to a blank screen" is
 * this task's acceptance, and a `Record<Zone['kind'], …>` lookup would satisfy the type checker
 * while still allowing `undefined` at runtime for a zone whose entry was forgotten. The switch is
 * what makes the guarantee structural.
 *
 * The zone is RECOMPUTED from auth truth on every render (see `zone.ts` for why there is no router):
 * an idle lock cannot leave a screen stranded behind a stale route, because there is no route to be
 * stale — only a gate that is asked again.
 */
import type { ReactElement } from 'react';

import type { Zone } from './zone.js';

export interface ZoneRenderers {
  readonly enrollment: (revoked: boolean) => ReactElement;
  readonly switcher: (zone: Extract<Zone, { kind: 'switcher' }>) => ReactElement;
  readonly pin: (zone: Extract<Zone, { kind: 'pin' }>) => ReactElement;
  readonly shell: (zone: Extract<Zone, { kind: 'shell' }>) => ReactElement;
}

/**
 * Render `zone`. Total by construction — see the header.
 *
 * Split out from the App component (rather than inlined) so the totality is testable without
 * standing up ports, a DB, and a session: a test can hand it a stub renderer per zone and assert
 * that every zone the gate can produce renders something.
 */
export function renderZone(zone: Zone, renderers: ZoneRenderers): ReactElement {
  switch (zone.kind) {
    case 'enrollment':
      return renderers.enrollment(zone.revoked);
    case 'switcher':
      return renderers.switcher(zone);
    case 'pin':
      return renderers.pin(zone);
    case 'shell':
      return renderers.shell(zone);
    default:
      return assertNever(zone);
  }
}

/**
 * The compile-time totality check. Reachable only if a `Zone` member is added without a renderer —
 * at which point `tsc` fails here, which is the entire point. The runtime throw is the belt to that
 * braces: a `Zone` smuggled in past the type system (a cast, a bad JSON parse) fails loudly rather
 * than rendering nothing at all.
 */
function assertNever(zone: never): never {
  throw new Error(`Unhandled zone: ${JSON.stringify(zone)}`);
}
