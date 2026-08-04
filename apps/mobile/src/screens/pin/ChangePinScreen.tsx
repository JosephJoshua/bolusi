/**
 * Change-your-own-PIN screen (api/02-auth §6.6; design-system §8.3). Renders `change-pin.model.ts`'s
 * machine and re-implements nothing: the model owns every transition and the DomainError→feedback
 * mapping, core owns the current-PIN verify + lockout, and this component only wires the PIN pad to
 * the reducer and runs the injected flow.
 *
 * THE FLOW IS AN INJECTED CALLBACK, NOT AN IMPORT. `onChangePin` runs `auth.changePin` for the caller
 * (the same seam PinScreen uses with `onSubmit`) — so this screen stays a pure function of props,
 * testable without a runtime, a DB, or a signing key. It REJECTS with the flow's DomainError; the
 * catch maps it through `changePinFailure`, which is the single place a rejected change is turned into
 * a pad message rather than a silent success.
 *
 * The pad is REMOUNTED per sub-step via `key`, so digits from the current-PIN step can never bleed
 * into the new-PIN entry — a fresh, empty pad for each of current / new / repeat.
 */
import { t } from '@bolusi/i18n';
import { AppShell, PinPad } from '@bolusi/ui';
import { useEffect, useReducer } from 'react';
import { View } from 'react-native';

import {
  CHANGE_PIN_START,
  changeMessageKey,
  changePadState,
  changePinFailure,
  changePinReducer,
  type ChangePinPhase,
} from './change-pin.model.js';
import { PinResultPanel } from './PinResultPanel.js';

export interface ChangePinScreenProps {
  /**
   * Run `auth.changePin` for the acting user. Resolves on success; REJECTS with the flow's
   * DomainError (`NOT_AUTHENTICATED` wrong current, `PIN_LOCKED`, `PIN_RATE_LIMITED`) on failure.
   */
  readonly onChangePin: (currentPin: string, newPin: string) => Promise<void>;
  /** Leave the screen — the header back, and the button after a successful change. */
  readonly onClose: () => void;
}

export function ChangePinScreen({ onChangePin, onClose }: ChangePinScreenProps): React.JSX.Element {
  const [phase, dispatch] = useReducer(changePinReducer, CHANGE_PIN_START);

  useEffect(() => {
    if (phase.kind !== 'submitting') return;
    let cancelled = false;
    void onChangePin(phase.currentPin, phase.newPin).then(
      () => {
        if (!cancelled) dispatch({ kind: 'settled', result: { ok: true } });
      },
      (error: unknown) => {
        if (!cancelled) dispatch({ kind: 'settled', result: changePinFailure(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [phase, onChangePin]);

  return (
    <AppShell
      title={t('auth.pin.change.title')}
      titleVariant="detail"
      onBack={onClose}
      backLabel={t('core.action.back')}
      syncChip={null}
      avatar={<View testID="change-pin-no-avatar" />}
      testID="change-pin-screen"
    >
      {phase.kind === 'done' ? (
        <PinResultPanel
          tone="success"
          chipLabel={t('core.action.ok')}
          message={t('auth.pin.change.done')}
          actionLabel={t('core.action.ok')}
          onAction={onClose}
          testID="change-pin-done"
        />
      ) : (
        <PinPad
          key={padKey(phase)}
          onComplete={(pin) => {
            if (phase.kind === 'current') dispatch({ kind: 'enteredCurrent', pin });
            else if (phase.kind === 'new') dispatch({ kind: 'enteredNew', pin });
          }}
          state={changePadState(phase)}
          message={messageFor(phase)}
          entryLabel={t('auth.pin.change.title')}
          backspaceLabel={t('core.action.delete')}
          testID="change-pin-pad"
        />
      )}
    </AppShell>
  );
}

/** A distinct key per sub-step so the pad remounts (and clears) between current / new / repeat. */
function padKey(phase: ChangePinPhase): string {
  if (phase.kind === 'new') return `new-${phase.entry.kind}`;
  return phase.kind;
}

/** The already-localized pad message for a phase, or undefined when the phase shows none. */
function messageFor(phase: ChangePinPhase): string | undefined {
  const key = changeMessageKey(phase);
  return key === null ? undefined : t(key);
}
