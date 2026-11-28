// The drawers in Metode pembayaran, shared by the phone and the PC: how a drawer reads in the list,
// and the add or edit form's state and save. A drawer used by every role is open to anyone who
// takes payments; one limited to some roles only to them, and owners use every drawer (rules.ts
// `drawerOpenTo`).
import { useState } from 'react';

import { useActionRunner, type ActionRunner } from '../screen-kit/index.js';

import { MONEY_PERMISSION } from './constants.js';
import { drawerLabel } from './drawers.js';
import { tm } from './i18n.js';
import type { DrawerRow } from './queries.js';
import { useMoneyQuery, useMoneyRuntime, type MoneyRole } from './runtime.js';

/** "Semua jabatan", or the roles it is limited to; a role this device does not know is left out. */
export function drawerUsers(drawer: DrawerRow, roles: readonly MoneyRole[]): string {
  if (drawer.roleIds.length === 0) return tm('money.drawers.everyone');
  return roles
    .filter((role) => drawer.roleIds.includes(role.id))
    .map((role) => role.name)
    .join(', ');
}

/** "Kasir, Manajer · Tidak dipakai". */
export function drawerSummary(drawer: DrawerRow, roles: readonly MoneyRole[]): string {
  return [drawerUsers(drawer, roles), drawer.active ? '' : tm('money.methods.inactive')]
    .filter((part) => part !== '')
    .join(' · ');
}

/** The main drawer first, then the others, switched-off ones last. */
export function drawersInOrder(rows: readonly DrawerRow[]): DrawerRow[] {
  const rest = rows.filter((row) => !row.main);
  return [
    ...rows.filter((row) => row.main),
    ...rest.filter((row) => row.active),
    ...rest.filter((row) => !row.active),
  ];
}

/** The roles a drawer can be limited to, as the staff list names them; empty while they load. */
export function useMoneyRoles(): readonly MoneyRole[] {
  const roles = useMoneyQuery((rt) => rt.roles(), 'roles');
  return roles.status === 'ready' ? roles.data : [];
}

/** Whether this person adds drawers and sets who uses them: a store owner. */
export function useMayManageDrawers(): boolean {
  return useMoneyRuntime().hasPermission(MONEY_PERMISSION.manageAccounts);
}

export interface DrawerForm {
  readonly runner: ActionRunner;
  readonly name: string;
  readonly setName: (name: string) => void;
  /** Used by every role, or only `picked`. */
  readonly everyone: boolean;
  readonly setEveryone: (everyone: boolean) => void;
  readonly picked: readonly string[];
  readonly togglePicked: (roleId: string) => void;
  readonly roles: readonly MoneyRole[];
  readonly active: boolean;
  readonly setActive: (active: boolean) => void;
  /** The main drawer is always on, so it has no switch. */
  readonly switchable: boolean;
  readonly dirty: boolean;
  /** A save was tried, so what is missing shows. */
  readonly tried: boolean;
  readonly nameMissing: boolean;
  readonly noRole: boolean;
  /** Saves it; `onDone` gets the notice to show. Nothing changed on an edit just closes it. */
  readonly save: (onDone: (notice: string) => void, onUnchanged: () => void) => void;
}

/** The add or edit form for one drawer; `drawer` absent to add one. */
export function useDrawerForm(drawer: DrawerRow | undefined): DrawerForm {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const roles = useMoneyRoles();
  const startName = drawer === undefined ? '' : drawerLabel(drawer);
  const [name, setName] = useState(startName);
  const [everyone, setEveryone] = useState((drawer?.roleIds.length ?? 0) === 0);
  const [picked, setPicked] = useState<readonly string[]>(drawer?.roleIds ?? []);
  const [active, setActive] = useState(drawer?.active ?? true);
  const [tried, setTried] = useState(false);
  const roleIds = everyone ? [] : [...picked].sort();

  const dirty =
    drawer === undefined
      ? name.trim() !== ''
      : name.trim() !== startName ||
        active !== drawer.active ||
        roleIds.join() !== [...drawer.roleIds].sort().join();
  const nameMissing = name.trim() === '';
  const noRole = !everyone && picked.length === 0;

  const save = (onDone: (notice: string) => void, onUnchanged: () => void): void => {
    setTried(true);
    if (nameMissing || noRole) return;
    if (drawer !== undefined && !dirty) {
      onUnchanged();
      return;
    }
    void runner
      .run(() =>
        runtime.run('saveDrawer', {
          ...(drawer === undefined ? {} : { drawer: drawer.ref }),
          name: name.trim(),
          active,
          roleIds,
        }),
      )
      .then((result) => {
        if (result !== undefined) onDone(tm('money.methods.saved', { name: name.trim() }));
      });
  };

  return {
    runner,
    name,
    setName,
    everyone,
    setEveryone,
    picked,
    togglePicked: (roleId) =>
      setPicked((current) =>
        current.includes(roleId) ? current.filter((id) => id !== roleId) : [...current, roleId],
      ),
    roles,
    active,
    setActive,
    switchable: drawer?.main !== true,
    dirty,
    tried,
    nameMissing,
    noRole,
    save,
  };
}
