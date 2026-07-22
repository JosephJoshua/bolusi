/**
 * The story-harness gate: every component in the §3/§8 inventory declares AND renders each of its
 * mandatory states.
 *
 * This is what removes "did the reviewer remember Button has four states?" from review. The registry
 * is typed `Record<InventoryName, …>` over the barrels, so a missing entry already fails `tsc`; this
 * file closes the loop at runtime and proves the declared states actually render.
 */
import { describe, expect, test } from 'vitest';

import * as componentInventory from '../src/components/index.js';
import { Gallery } from '../src/gallery/Gallery.js';
import { stateRegistry, type GalleryLabels } from '../src/gallery/registry.js';
import * as shellInventory from '../src/shell/index.js';
import { fire, render } from './render.js';

/**
 * Obvious placeholders. Copy is never asserted (testing-guide T-4) — these exist only to satisfy
 * the already-localized-string contract every component has.
 */
const labels: GalleryLabels = {
  action: 'action',
  cancel: 'cancel',
  confirm: 'confirm',
  back: 'back',
  retry: 'retry',
  create: 'create',
  title: 'title',
  hint: 'hint',
  message: 'message',
  fieldLabel: 'fieldLabel',
  fieldPlaceholder: 'fieldPlaceholder',
  fieldError: 'fieldError',
  primaryText: 'primaryText',
  secondaryText: 'secondaryText',
  errorCode: 'errorCode',
  pendingChip: 'pendingChip',
  rejectedChip: 'rejectedChip',
  pinEntry: 'pinEntry',
  pinBackspace: 'pinBackspace',
  pinError: 'pinError',
  pinLocked: 'pinLocked',
  syncChip: 'syncChip',
  avatarSwitch: 'avatarSwitch',
  initials: 'SW',
};

const inventoryNames = [...Object.keys(componentInventory), ...Object.keys(shellInventory)].sort();

describe('registry ↔ inventory (the list is never hand-maintained twice)', () => {
  test('every exported component has a registry entry', () => {
    expect(Object.keys(stateRegistry).sort()).toEqual(inventoryNames);
  });

  test('the registry declares no component that is not exported', () => {
    for (const name of Object.keys(stateRegistry)) expect(inventoryNames).toContain(name);
  });

  test('every component declares at least one state', () => {
    for (const [name, states] of Object.entries(stateRegistry)) {
      expect(states.length, `${name} declares no states`).toBeGreaterThan(0);
    }
  });

  test('state ids are unique per component', () => {
    for (const [name, states] of Object.entries(stateRegistry)) {
      const ids = states.map((s) => s.id);
      expect(new Set(ids).size, `${name} has duplicate state ids`).toBe(ids.length);
    }
  });
});

describe('every declared state renders', () => {
  const cases = Object.entries(stateRegistry).flatMap(([name, states]) =>
    states.map((state) => [`${name} / ${state.id}`, name, state] as const),
  );

  test.each(cases)('%s', (_label, _name, state) => {
    const r = render(<>{state.render(labels)}</>);
    // Interaction-only states (Button `pressed`) are reached the way a user reaches them.
    if (state.activatesOnPressIn === true) {
      const pressables = r.container.queryAll((node) => node.props['onPressIn'] !== undefined);
      expect(pressables.length).toBeGreaterThan(0);
      fire(pressables[0]!, 'onPressIn');
    }
    expect(r.container).toBeDefined();
  });
});

describe('the §3 inventory covers what design-system §3 requires', () => {
  test('Button: 4 states x 3 variants', () => {
    expect(stateRegistry.Button).toHaveLength(12);
    for (const variant of ['primary', 'secondary', 'destructive']) {
      for (const state of ['default', 'pressed', 'disabled', 'busy']) {
        expect(stateRegistry.Button.map((s) => s.id)).toContain(`${variant}.${state}`);
      }
    }
  });

  test.each([
    ['TextInput', ['default', 'focused', 'error', 'disabled', 'multiline']],
    ['PinPad', ['entry', 'error', 'locked']],
    ['SyncStatusChip', ['synced', 'pending', 'rejected']],
    ['LoadingState', ['skeleton', 'spinner']],
    ['FreshnessCell', ['fresh', 'warning', 'stale']],
    ['SyncChip', ['synced', 'pending', 'syncing', 'offline', 'attention']],
    ['List', ['loading', 'empty', 'error', 'unauthorized', 'ready']],
  ] as const)('%s declares %j', (name, expected) => {
    const ids = stateRegistry[name as keyof typeof stateRegistry].map((s) => s.id);
    for (const id of expected) expect(ids).toContain(id);
  });

  test('Banner declares all three §3.6 variants', () => {
    const ids = stateRegistry.Banner.map((s) => s.id);
    for (const variant of ['info', 'warning', 'danger']) {
      expect(ids.some((id) => id.startsWith(variant))).toBe(true);
    }
  });
});

describe('Gallery', () => {
  test('renders every component and every state from the registry', () => {
    const r = render(<Gallery labels={labels} />);
    for (const [name, states] of Object.entries(stateRegistry)) {
      expect(r.query(`ui.gallery.${name}`), `${name} section missing`).not.toBeNull();
      for (const state of states) {
        expect(
          r.query(`ui.gallery.${name}.${state.id}`),
          `${name}/${state.id} missing`,
        ).not.toBeNull();
      }
    }
  });
});
