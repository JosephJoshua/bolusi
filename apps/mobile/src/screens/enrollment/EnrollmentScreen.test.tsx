// The enrolment wizard at the render boundary. The confirm step is where §8.5's wrong-store
// control lives, and store binding is IRREVERSIBLE (api/02-auth §7.4): undoing it costs an operator
// round trip. The control is now the step's one button NAMING the picked store, with the picked row
// checked; a separate "Ya, lanjutkan" toggle above a "Masuk" button used to do this job, and the
// first Android QA run found the pair confusing. These tests pin the replacement.
import { initI18n, t } from '@bolusi/i18n';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { fire, render, textsIn } from '../../../../../packages/ui/test/render.js';

import { EnrollmentScreen } from './EnrollmentScreen.js';
import { initialEnrollmentState, type EnrollmentState } from './model.js';

const STORE_A = { id: 'store-a', name: 'Cabang Sorong' };
const STORE_B = { id: 'store-b', name: 'Cabang Manokwari' };

beforeAll(() => {
  initI18n({ locale: 'id' });
});

/** A state parked on the confirm step with two stores offered and store A picked. */
function onA(over: Partial<EnrollmentState> = {}): EnrollmentState {
  return {
    ...initialEnrollmentState(),
    step: 'confirm',
    deviceName: 'Kasir 1',
    login: {
      controlSession: 'cs_token',
      tenantId: 'tenant-1',
      tenantName: 'Bengkel Jaya',
      user: { id: 'user-1', name: 'Pak Owner' },
      stores: [STORE_A, STORE_B],
    },
    selectedStoreId: STORE_A.id,
    ...over,
  };
}

function renderScreen(
  state: EnrollmentState,
  onChange: (patch: Partial<EnrollmentState>) => void,
  onEnroll: () => void = () => undefined,
) {
  return render(
    <EnrollmentScreen
      state={state}
      onChange={onChange}
      onLogin={() => undefined}
      onEnroll={onEnroll}
      onFinish={() => undefined}
      onBack={() => undefined}
      discardPrompt={false}
      onConfirmDiscard={() => undefined}
      onCancelDiscard={() => undefined}
    />,
  );
}

describe('the store step: one choice, one button that names it (design-system §8.5)', () => {
  test('the bind button names the picked store, and binds on press', () => {
    const onEnroll = vi.fn();
    const screen = renderScreen(onA(), vi.fn(), onEnroll);
    const bind = screen.get('enroll-bind');
    expect(textsIn(bind)).toContain(t('auth.enroll.bind', { store: STORE_A.name }));
    fire(bind, 'onPress');
    expect(onEnroll).toHaveBeenCalledTimes(1);
  });

  test('switching stores changes what the button says, so it cannot bind the old one unseen', () => {
    const screen = renderScreen(onA({ selectedStoreId: STORE_B.id }), vi.fn());
    expect(textsIn(screen.get('enroll-bind'))).toContain(
      t('auth.enroll.bind', { store: STORE_B.name }),
    );
  });

  test('only the picked store row is checked', () => {
    const screen = renderScreen(onA(), vi.fn());
    expect(screen.get(`enroll-store-${STORE_A.id}`).props['accessibilityState']).toEqual({
      checked: true,
      selected: true,
    });
    expect(screen.get(`enroll-store-${STORE_B.id}`).props['accessibilityState']).toEqual({
      checked: false,
      selected: false,
    });
  });

  test('tapping a store picks it', () => {
    const onChange = vi.fn();
    const screen = renderScreen(onA(), onChange);
    fire(screen.get(`enroll-store-${STORE_B.id}`), 'onPress');
    expect(onChange).toHaveBeenCalledWith({ selectedStoreId: STORE_B.id });
  });

  test('with no store picked the button is disabled and says to pick one first', () => {
    const screen = renderScreen(onA({ selectedStoreId: null }), vi.fn());
    expect(screen.get('enroll-bind').props['disabled']).toBe(true);
    expect(textsIn(screen.get('enroll-hint'))).toEqual([t('auth.enroll.pickStoreFirst')]);
  });

  test('without a device name the button is disabled and asks for one', () => {
    const screen = renderScreen(onA({ deviceName: '' }), vi.fn());
    expect(screen.get('enroll-bind').props['disabled']).toBe(true);
    expect(textsIn(screen.get('enroll-hint'))).toEqual([t('auth.enroll.nameDeviceFirst')]);
  });

  test('the device field is labelled as the device, not the account', () => {
    const screen = renderScreen(onA(), vi.fn());
    expect(textsIn(screen.get('enroll-device-name.label'))).toEqual([
      t('auth.enroll.deviceNameField'),
    ]);
    expect(t('auth.enroll.deviceNameField')).not.toBe(t('auth.enroll.identifierField'));
  });

  test('there is no separate confirmation toggle', () => {
    const screen = renderScreen(onA(), vi.fn());
    expect(screen.query('enroll-confirm-toggle')).toBeNull();
  });
});

describe('before enrolment there is no sync to report', () => {
  test('the header carries no sync chip', () => {
    const screen = renderScreen(initialEnrollmentState(), vi.fn());
    expect(
      screen.container.queryAll(
        (n) =>
          typeof n.props['testID'] === 'string' && /syncChip/i.test(n.props['testID'] as string),
      ),
    ).toHaveLength(0);
  });
});

// ── task 128 regression control: enrollment's fields are NOT swept into the multiline variant ────
// Task 128 gave the shared TextInput a `multiline` capability for the §8.6 note body. It is additive
// by design, and this is the assertion that keeps it additive: an identifier, a password, and a
// device name are one-line values, and a change that flipped the shared default would silently turn
// all three into growing boxes. It is deliberately filed against the CALL SITES, because the
// component's own default passing proves nothing about what these three actually pass.
describe('enrollment fields stay single-line after the §8.6 multiline variant (task 128)', () => {
  test('identifier and password declare multiline false', () => {
    const screen = renderScreen(initialEnrollmentState(), vi.fn());

    expect(screen.get('enroll-identifier.field').props['multiline']).toBe(false);
    expect(screen.get('enroll-password.field').props['multiline']).toBe(false);
    // A password box that grew line-by-line would also change how much of the entry is on screen.
    expect(screen.get('enroll-password.field').props['secureTextEntry']).toBe(true);
  });

  test('the device-name field on the confirm step declares multiline false', () => {
    const screen = renderScreen(onA(), vi.fn());

    expect(screen.get('enroll-device-name.field').props['multiline']).toBe(false);
  });
});
