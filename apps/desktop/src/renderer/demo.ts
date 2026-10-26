// Demo data for the first desktop build, which runs the counter screens over the in-memory repair
// demo before the offline core is wired in. Names here are seeded data, not interface copy.
import { demoRepairRuntime, type DemoRepairRole } from '@bolusi/modules/repair/demo';
import type { RepairRuntime } from '@bolusi/modules/repair/desktop';

export const DEMO_STORE_NAME = 'Toko Sorong Kota';

export interface DemoPerson {
  readonly role: DemoRepairRole;
  readonly userId: string;
  readonly name: string;
  /** The role catalog key (`role.<key>.name`) the person holds. */
  readonly roleKey: string;
}

export const DEMO_PEOPLE: readonly DemoPerson[] = [
  { role: 'counter', userId: 'u-siti', name: 'Siti Rahayu', roleKey: 'cashier' },
  { role: 'owner', userId: 'u-andi', name: 'Andi Pratama', roleKey: 'main_owner' },
  { role: 'storeOwner', userId: 'u-yosua', name: 'Yosua Wonda', roleKey: 'store_owner' },
  { role: 'technician', userId: 'u-budi', name: 'Budi Santoso', roleKey: 'technician' },
];

/** A fresh store's worth of servisan for this person; switching people starts over. */
export function demoRuntimeFor(person: DemoPerson): RepairRuntime {
  return demoRepairRuntime(person.role, { now: Date.now(), volume: 'store' });
}
