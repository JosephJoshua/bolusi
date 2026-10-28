/**
 * "Karyawan" in the visual harness: the real `StaffScreen` over an in-memory stand-in for the server,
 * so the browser can click through adding someone, the PIN hand-over that follows (the real
 * `StaffPinScreen`), editing, deactivating and reactivating. `offline` makes every change fail the
 * way it does with no connection.
 */
import {
  StaffAdminError,
  type StaffDirectory,
  type StaffMember,
  type StaffRole,
} from '@bolusi/core';
import { useRef, useState } from 'react';

import { StaffPinScreen } from '../screens/pin/StaffPinScreen.js';
import { LimitsScreen } from '../screens/staff/LimitsScreen.js';
import { StaffScreen } from '../screens/staff/StaffScreen.js';

const ROLES: readonly StaffRole[] = [
  { id: 'r-cashier', key: 'cashier', ownerRole: false, limits: null },
  { id: 'r-tech', key: 'technician', ownerRole: false, limits: null },
  {
    id: 'r-manager',
    key: 'manager',
    ownerRole: false,
    limits: { priceDrop: 50_000, refund: 0, credit: 100_000 },
  },
  { id: 'r-store', key: 'store_owner', ownerRole: true, limits: null },
];

const KEY_BY_ID: Record<string, string> = {
  'r-cashier': 'cashier',
  'r-tech': 'technician',
  'r-manager': 'manager',
  'r-store': 'store_owner',
  'r-main': 'main_owner',
};

function member(
  id: string,
  name: string,
  roleIds: readonly string[],
  over: Partial<StaffMember> = {},
): StaffMember {
  return {
    id,
    name,
    active: true,
    roleIds,
    roleKeys: roleIds.map((roleId) => KEY_BY_ID[roleId] ?? roleId),
    owner: roleIds.includes('r-store') || roleIds.includes('r-main'),
    hasPin: true,
    ...over,
  };
}

export const STAFF_ACTOR = 'u-andi';

/** A small store: the owner, a cashier who also repairs, a technician, someone without a PIN yet,
 *  the main owner, and one person who left. */
export const STAFF_DEMO: readonly StaffMember[] = [
  member(STAFF_ACTOR, 'Andi Pratama', ['r-store']),
  member('u-ocep', 'Ocep Wanggai', ['r-main']),
  member('u-yohanis', 'Yohanis Mandowen', ['r-cashier', 'r-tech']),
  member('u-maria', 'Maria Kogoya', ['r-tech']),
  member('u-daniel', 'Daniel Rumaropen', ['r-manager']),
  member('u-petrus', 'Petrus Yikwa', ['r-cashier'], { hasPin: false }),
  member('u-selfina', 'Selfina Ayomi', ['r-cashier'], { active: false, hasPin: false }),
];

/** A busy store with long names, for the list at realistic volume. */
export const STAFF_MANY: readonly StaffMember[] = [
  ...STAFF_DEMO,
  ...[
    'Ester Mandowen',
    'Agustinus Wenda',
    'Fransiska Rumbiak',
    'Kristian Tabuni',
    'Natalia Wamafma Rumbekwan',
    'Lukas Enembe',
    'Fransiskus Xaverius Kambuaya',
    'Debora Sawaki',
  ].map((name, index) =>
    member(`u-many-${String(index)}`, name, index % 3 === 0 ? ['r-tech'] : ['r-cashier'], {
      hasPin: index !== 4,
    }),
  ),
];

function sortMembers(members: readonly StaffMember[]): readonly StaffMember[] {
  return [...members].sort((a, b) =>
    a.active !== b.active ? (a.active ? -1 : 1) : a.name.localeCompare(b.name),
  );
}

export function StaffDemo({
  members,
  tenantAdmin = false,
  offline = false,
}: {
  readonly members: readonly StaffMember[];
  readonly tenantAdmin?: boolean;
  readonly offline?: boolean;
}): React.JSX.Element {
  const [directory, setDirectory] = useState<StaffDirectory>({
    roles: ROLES,
    members: sortMembers(members),
  });
  const [pinFor, setPinFor] = useState<string | null>(null);
  // The latest directory for the screen's re-read after a change, ahead of React's next render.
  const latest = useRef(directory);
  const change = (next: (members: readonly StaffMember[]) => readonly StaffMember[]): void => {
    latest.current = { ...latest.current, members: sortMembers(next(latest.current.members)) };
    setDirectory(latest.current);
  };
  const server = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (offline) throw new StaffAdminError('offline');
  };

  if (pinFor !== null) {
    return (
      <StaffPinScreen
        canUnlock
        canReset
        loading={false}
        error={null}
        users={directory.members
          .filter((m) => m.active)
          .map((m) => ({
            id: m.id,
            name: m.name,
            roleKeys: m.roleKeys,
            lockedOut: false,
            needsFirstPin: !m.hasPin,
          }))}
        actorUserId={STAFF_ACTOR}
        onClearLockout={() => Promise.resolve()}
        onResetPin={(userId) => {
          change((all) => all.map((m) => (m.id === userId ? { ...m, hasPin: true } : m)));
          return Promise.resolve();
        }}
        onReload={() => undefined}
        startWith={pinFor}
        onClose={() => setPinFor(null)}
      />
    );
  }

  return (
    <StaffScreen
      actor={{ userId: STAFF_ACTOR, tenantAdmin }}
      load={() => Promise.resolve(latest.current)}
      onCreate={async (draft) => {
        await server();
        const id = `u-new-${String(latest.current.members.length)}`;
        change((all) => [...all, member(id, draft.name, draft.roleIds, { hasPin: false })]);
        return { userId: id };
      }}
      onUpdate={async (userId, edit) => {
        await server();
        change((all) =>
          all.map((m) =>
            m.id === userId
              ? member(m.id, edit.name ?? m.name, edit.roleIds ?? m.roleIds, {
                  hasPin: m.hasPin,
                })
              : m,
          ),
        );
      }}
      onSetActive={async (userId, active) => {
        await server();
        change((all) => all.map((m) => (m.id === userId ? { ...m, active } : m)));
      }}
      onMakePin={setPinFor}
      onClose={() => undefined}
    />
  );
}

/**
 * "Batas wewenang" in the visual harness: the real `LimitsScreen` over the same in-memory server.
 * `extraRole` adds a second limited role, for the list a business with custom roles sees.
 */
export function LimitsDemo({
  offline = false,
  extraRole = false,
}: {
  readonly offline?: boolean;
  readonly extraRole?: boolean;
}): React.JSX.Element {
  const latest = useRef<StaffDirectory>({
    roles: extraRole
      ? [
          ...ROLES,
          {
            id: 'r-senior',
            key: 'technician',
            ownerRole: false,
            limits: { priceDrop: 25_000, refund: 0, credit: 0 },
          },
        ]
      : ROLES,
    members: sortMembers(STAFF_DEMO),
  });
  return (
    <LimitsScreen
      actor={{ userId: STAFF_ACTOR, tenantAdmin: false }}
      load={() => Promise.resolve(latest.current)}
      onSave={async (roleId, limits) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (offline) throw new StaffAdminError('offline');
        latest.current = {
          ...latest.current,
          roles: latest.current.roles.map((role) =>
            role.id === roleId ? { ...role, limits } : role,
          ),
        };
      }}
      onClose={() => undefined}
    />
  );
}
