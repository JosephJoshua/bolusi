// THE WRONG-STORE CONTROL (design-system §8.5) — `EnrollmentScreen.tsx`'s
// `onChange({ selectedStoreId: store.id, confirmed: false })`.
//
// ── WHY THIS FILE EXISTS (task 24's review, carried to task 50) ────────────────────────────────
// That single `confirmed: false` is the ONLY thing enforcing §8.5's wrong-store control, and store
// binding is IRREVERSIBLE (api/02-auth §7.4) — undoing it costs an operator round-trip. Until this
// file, there was no `EnrollmentScreen.test.tsx` at all: the model tests covered `canSubmitConfirm`'s
// gating, and nothing covered the line that FEEDS it. **Delete `confirmed: false` in a refactor and
// nothing went red.** An irreversible, operator-costly binding whose sole guard was untested.
//
// ── WHAT review-05 GOT RIGHT, AND WHY IT IS PROTECTED BY CONSTRUCTION ─────────────────────────
// review-05 hypothesised the real hole — confirm store A → transport fails → switch to store B →
// bind B unconfirmed — and DISPROVED it: that line re-arms the confirmation on every store change,
// so flapping the network rebinds the same confirmed store. Task 24's judgement (`confirmed`
// survives a transport failure: "the network failed, not the user's intent") is correct. The
// finding was never that the behaviour is wrong; it is that NOTHING PROVED IT. This file is the
// proof, and the `re-confirming B re-enables submit` test below is the positive control that keeps
// it honest — a test that only ever asserts "blocked" passes on a screen that blocks everything
// (T-14b).
import { render, fire } from '../../../../../packages/ui/test/render.js';
import { describe, expect, test, vi } from 'vitest';

import { EnrollmentScreen } from './EnrollmentScreen.js';
import { canSubmitConfirm, initialEnrollmentState, type EnrollmentState } from './model.js';

const STORE_A = { id: 'store-a', name: 'Cabang Sorong' };
const STORE_B = { id: 'store-b', name: 'Cabang Manokwari' };

/** A state parked on the confirm step with two stores offered and store A already confirmed. */
function confirmedOnA(over: Partial<EnrollmentState> = {}): EnrollmentState {
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
    confirmed: true,
    ...over,
  };
}

function renderConfirm(
  state: EnrollmentState,
  onChange: (patch: Partial<EnrollmentState>) => void,
) {
  return render(
    <EnrollmentScreen
      state={state}
      onChange={onChange}
      onLogin={() => undefined}
      onEnroll={() => undefined}
      onFinish={() => undefined}
      onBack={() => undefined}
      discardPrompt={false}
      onConfirmDiscard={() => undefined}
      onCancelDiscard={() => undefined}
    />,
  );
}

describe('changing the store RE-ARMS the confirmation (design-system §8.5)', () => {
  test('confirm A → tap B ⇒ the patch carries confirmed: false, not just the new store id', () => {
    // THE ASSERTION THE WHOLE FILE IS FOR. A patch of `{ selectedStoreId: 'store-b' }` alone would
    // carry store A's confirmation onto store B — binding this device, irreversibly, to a store
    // nobody confirmed. The screen must re-arm.
    const onChange = vi.fn();
    const screen = renderConfirm(confirmedOnA(), onChange);

    fire(screen.get(`enroll-store-${STORE_B.id}`), 'onPress');

    expect(onChange).toHaveBeenCalledWith({ selectedStoreId: STORE_B.id, confirmed: false });
  });

  test('the re-armed state GATES submit — the consequence, not just the patch', () => {
    // The patch assertion above proves the screen SAYS `confirmed: false`. This proves it MATTERS:
    // applying that patch produces a state whose submit is blocked. Asserting the patch alone would
    // stay green if `canSubmitConfirm` stopped reading `confirmed`.
    const state = confirmedOnA();
    expect(canSubmitConfirm(state)).toBe(true); // precondition: A really was submittable

    const switched: EnrollmentState = { ...state, selectedStoreId: STORE_B.id, confirmed: false };
    expect(canSubmitConfirm(switched)).toBe(false);
  });

  test('the bind button is DISABLED after switching stores', () => {
    // The user-visible half, at the render boundary: §8.5's control is only real if the button the
    // user would press is actually inert.
    const switched = confirmedOnA({ selectedStoreId: STORE_B.id, confirmed: false });
    const screen = renderConfirm(switched, vi.fn());

    expect(screen.get('enroll-bind').props['disabled']).toBe(true);
  });

  test('POSITIVE CONTROL: re-confirming B re-enables submit — the screen does not block everything', () => {
    // T-14b. Without this, every assertion above would pass on a screen that disabled the bind
    // button unconditionally — i.e. on an app that can never enroll. A guard that blocks the happy
    // path is not a guard, it is an outage.
    const reconfirmed = confirmedOnA({ selectedStoreId: STORE_B.id, confirmed: true });
    expect(canSubmitConfirm(reconfirmed)).toBe(true);

    const screen = renderConfirm(reconfirmed, vi.fn());
    expect(screen.get('enroll-bind').props['disabled']).toBe(false);
  });

  test('re-tapping the SAME store still re-arms — confirmation is per-tap, not per-store', () => {
    // The subtle one. If the screen only re-armed when the id CHANGED, a user who tapped their
    // already-confirmed store would keep a confirmation they did not re-give. Cheap to hold, and it
    // is the behaviour the one-line implementation already has — asserted so a "smarter" refactor
    // (`if (store.id !== state.selectedStoreId)`) fails here rather than shipping.
    const onChange = vi.fn();
    const screen = renderConfirm(confirmedOnA(), onChange);

    fire(screen.get(`enroll-store-${STORE_A.id}`), 'onPress');

    expect(onChange).toHaveBeenCalledWith({ selectedStoreId: STORE_A.id, confirmed: false });
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
    const screen = renderConfirm(initialEnrollmentState(), vi.fn());

    expect(screen.get('enroll-identifier.field').props['multiline']).toBe(false);
    expect(screen.get('enroll-password.field').props['multiline']).toBe(false);
    // A password box that grew line-by-line would also change how much of the entry is on screen.
    expect(screen.get('enroll-password.field').props['secureTextEntry']).toBe(true);
  });

  test('the device-name field on the confirm step declares multiline false', () => {
    const screen = renderConfirm(confirmedOnA(), vi.fn());

    expect(screen.get('enroll-device-name.field').props['multiline']).toBe(false);
  });
});
