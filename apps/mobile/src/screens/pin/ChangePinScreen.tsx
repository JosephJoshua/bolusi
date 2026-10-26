/**
 * Change-your-own-PIN screen (api/02-auth §6.6; design-system §8.3). Renders `change-pin.model.ts`'s
 * machine and re-implements nothing: the model owns every transition and the DomainError→feedback
 * mapping, core owns the current-PIN verify + lockout, and this component only wires the shared
 * `PinEntry` to the reducer and runs the injected flow.
 *
 * THE FLOW IS AN INJECTED CALLBACK, NOT AN IMPORT. `onChangePin` runs `auth.changePin` for the caller
 * (the same seam PinScreen uses with `onSubmit`) — so this screen stays a pure function of props,
 * testable without a runtime, a DB, or a signing key. It REJECTS with the flow's DomainError; the
 * catch maps it through `changePinFailure`, which is the single place a rejected change is turned into
 * pad feedback rather than a silent success.
 *
 * The pad is REMOUNTED per sub-step via `padKey`, so digits from the current-PIN step can never bleed
 * into the new-PIN entry — a fresh, empty pad for each of current / new / repeat.
 */
import { t } from '@bolusi/i18n';
import { AppShell, Button, OutcomeState } from '@bolusi/ui';
import { useEffect, useReducer } from 'react';
import { View } from 'react-native';

import {
  CHANGE_PIN_START,
  changeFeedbackKey,
  changePadState,
  changePinFailure,
  changePinReducer,
  changePromptKey,
  type ChangePinPhase,
} from './change-pin.model.js';
import { PinEntry, type PinEntryPerson } from './PinEntry.js';

export interface ChangePinScreenProps {
  /** Whose PIN is changing: the signed-in user, shown above the pad as on every PIN screen. */
  readonly person?: PinEntryPerson | undefined;
  /**
   * Run `auth.changePin` for the acting user. Resolves on success; REJECTS with the flow's
   * DomainError (`NOT_AUTHENTICATED` wrong current, `PIN_LOCKED`, `PIN_RATE_LIMITED`) on failure.
   */
  readonly onChangePin: (currentPin: string, newPin: string) => Promise<void>;
  /** Leave the screen — the header back, and the button after a successful change. */
  readonly onClose: () => void;
}

export function ChangePinScreen({
  person,
  onChangePin,
  onClose,
}: ChangePinScreenProps): React.JSX.Element {
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

  const prompt = changePromptKey(phase);
  const feedback = changeFeedbackKey(phase);

  return (
    <AppShell
      // Plain views, no List — safe to scroll when the content outgrows the viewport (task 206).
      scrollable
      title={t('auth.pin.change.title')}
      titleVariant="detail"
      onBack={onClose}
      backLabel={t('core.action.back')}
      syncChip={null}
      avatar={<View testID="change-pin-no-avatar" />}
      bottomAction={
        phase.kind === 'done' ? (
          <Button
            label={t('auth.pin.staff.finish')}
            onPress={onClose}
            testID="change-pin-done-action"
          />
        ) : undefined
      }
      testID="change-pin-screen"
    >
      {phase.kind === 'done' ? (
        <OutcomeState
          tone="success"
          icon="success"
          title={t('auth.pin.change.done')}
          message={t('auth.pin.change.doneBody')}
          testID="change-pin-done"
        />
      ) : (
        <PinEntry
          person={person}
          // While submitting, the just-completed pad stays up, frozen, for the one local write.
          prompt={t(prompt ?? 'auth.pin.setup.repeat')}
          message={feedback === null ? undefined : t(feedback)}
          state={phase.kind === 'submitting' ? 'locked' : changePadState(phase)}
          onComplete={(pin) => {
            if (phase.kind === 'current') dispatch({ kind: 'enteredCurrent', pin });
            else if (phase.kind === 'new') dispatch({ kind: 'enteredNew', pin });
          }}
          padKey={padKey(phase)}
          backspaceLabel={t('core.action.delete')}
          testID="change-pin"
        />
      )}
    </AppShell>
  );
}

/** A distinct key per sub-step so the pad remounts (and clears) between current / new / repeat. */
function padKey(phase: ChangePinPhase): string {
  if (phase.kind === 'new') {
    return `new-${phase.entry.kind}-${String(phase.entry.kind === 'first' && phase.entry.afterMismatch)}`;
  }
  if (phase.kind === 'current') return `current-${phase.feedback}`;
  return phase.kind;
}
