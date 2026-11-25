/**
 * The approval PIN on a phone (owner decision 2026-11-25): asked when an owner's or manager's
 * decision on a shared phone needs it, and set or changed from Settings. Only the server checks it,
 * so every step is online. The flows are the PC's (device models/approval-pin); this screen only
 * wires them to `PinEntry` and the port.
 *
 * Shown over the screen that asked (an overlay, like the camera), so that screen keeps its state
 * and its save runs once more when a decision session opened (core port.ts `retryAfterDecision`).
 */
import { approvalPinFailure, type ApprovalPinProof } from '@bolusi/core';
import type { DecisionOpening } from '@bolusi/device/bootstrap/person-access';
import {
  ASK_START,
  askFeedbackKey,
  askPadKey,
  askPadState,
  askReducer,
  setupFailureKey,
  setupNewFeedbackKey,
  setupNewPromptKey,
  setupReducer,
  setupStart,
  type ProofKind,
  type SetupEvent,
  type SetupPhase,
} from '@bolusi/device/models/approval-pin/model';
import { newPinPadKey, newPinPadState } from '@bolusi/device/models/pin/new-pin';
import { t } from '@bolusi/i18n';
import {
  AppShell,
  Button,
  ListRow,
  OutcomeState,
  Text,
  TextInput,
  space,
  type as typeScale,
  color,
} from '@bolusi/ui';
import { useEffect, useReducer, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useLatestCallback } from '../../hooks/useLatestCallback.js';
import { PinEntry, type PinEntryPerson } from './PinEntry.js';

/** An owner signed in on this phone who may confirm a colleague's approval PIN. */
export interface ConfirmingOwner {
  readonly userId: string;
  readonly name: string;
}

export interface ApprovalPinPort {
  /** Open a decision session with the signed-in person's approval PIN. */
  readonly open: (approvalPin: string) => Promise<DecisionOpening>;
  /** Set their own; REJECTS with an `ApprovalPinError`. */
  readonly set: (pin: string, proof: ApprovalPinProof | undefined) => Promise<void>;
}

export interface ApprovalPinScreenProps {
  /** `ask`: a decision is waiting on it. `setup`: Settings, to set or change it. */
  readonly mode: 'ask' | 'setup';
  readonly person: PinEntryPerson;
  readonly port: ApprovalPinPort;
  readonly proofKinds: readonly ProofKind[];
  readonly owners: readonly ConfirmingOwner[];
  /** Leave: `true` once a decision session opened (ask) or the PIN was saved (setup). */
  readonly onDone: (ok: boolean) => void;
}

export function ApprovalPinScreen(props: ApprovalPinScreenProps): React.JSX.Element {
  const [settingUp, setSettingUp] = useState(props.mode === 'setup');
  if (settingUp) {
    return (
      <ApprovalPinSetup
        {...props}
        // Asked by a decision: they have none, so their current one is no proof.
        proofKinds={
          props.mode === 'ask'
            ? props.proofKinds.filter((kind) => kind !== 'current')
            : props.proofKinds
        }
        openAfter={props.mode === 'ask'}
      />
    );
  }
  return <ApprovalPinAsk {...props} onSetUp={() => setSettingUp(true)} />;
}

function ApprovalPinAsk({
  person,
  port,
  onDone,
  onSetUp,
}: ApprovalPinScreenProps & { readonly onSetUp: () => void }): React.JSX.Element {
  const [phase, dispatch] = useReducer(askReducer, ASK_START);
  const open = useLatestCallback(port.open);
  const done = useLatestCallback(onDone);

  useEffect(() => {
    if (phase.kind === 'opened') {
      done(true);
      return;
    }
    if (phase.kind !== 'checking') return;
    let cancelled = false;
    void open(phase.pin).then(
      (outcome) => !cancelled && dispatch({ kind: 'checked', outcome }),
      () => !cancelled && dispatch({ kind: 'checked', outcome: 'failed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [phase, open, done]);

  const feedback = askFeedbackKey(phase);
  return (
    <AppShell
      scrollable
      title={t('auth.approval.ask.title')}
      titleVariant="detail"
      onBack={() => (phase.kind === 'checking' ? undefined : onDone(false))}
      backLabel={t('core.action.back')}
      syncChip={null}
      avatar={<View testID="approval-ask-no-avatar" />}
      bottomAction={
        phase.kind === 'notSet' ? (
          <Button
            label={t('auth.approval.ask.create')}
            onPress={onSetUp}
            testID="approval-ask-create"
          />
        ) : undefined
      }
      testID="approval-ask-screen"
    >
      {phase.kind === 'notSet' ? (
        <OutcomeState
          tone="neutral"
          icon="lock"
          title={t('auth.approval.ask.notSetTitle')}
          message={t('auth.approval.ask.notSetBody')}
          testID="approval-ask-not-set"
        />
      ) : (
        <View style={styles.gap}>
          <Text style={styles.body}>{t('auth.approval.ask.body')}</Text>
          <PinEntry
            person={person}
            prompt={t('auth.approval.ask.prompt')}
            message={feedback === null ? undefined : t(feedback)}
            busyLabel={phase.kind === 'checking' ? t('auth.approval.ask.checking') : undefined}
            state={padStateOf(askPadState(phase))}
            onComplete={(pin) => dispatch({ kind: 'entered', pin })}
            padKey={askPadKey(phase)}
            backspaceLabel={t('core.action.delete')}
            testID="approval-ask"
          />
        </View>
      )}
    </AppShell>
  );
}

function ApprovalPinSetup({
  person,
  port,
  proofKinds,
  owners,
  openAfter,
  onDone,
}: ApprovalPinScreenProps & { readonly openAfter: boolean }): React.JSX.Element {
  const [phase, dispatch] = useReducer(setupReducer, proofKinds, setupStart);
  const set = useLatestCallback(port.set);
  const open = useLatestCallback(port.open);

  useEffect(() => {
    if (phase.kind !== 'saving') return;
    let cancelled = false;
    void (async () => {
      try {
        await set(phase.pin, phase.proof ?? undefined);
      } catch (error) {
        if (!cancelled) dispatch({ kind: 'failed', failure: approvalPinFailure(error) });
        return;
      }
      if (openAfter) await open(phase.pin).catch(() => 'failed' as const);
      if (!cancelled) dispatch({ kind: 'saved' });
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, set, open, openAfter]);

  return (
    <AppShell
      scrollable
      title={t('auth.approval.setup.title')}
      titleVariant="detail"
      onBack={() => (phase.kind === 'saving' ? undefined : onDone(phase.kind === 'done'))}
      backLabel={t('core.action.back')}
      syncChip={null}
      avatar={<View testID="approval-setup-no-avatar" />}
      bottomAction={
        phase.kind === 'done' ? (
          <Button
            label={t('auth.pin.staff.finish')}
            onPress={() => onDone(true)}
            testID="approval-setup-finish"
          />
        ) : undefined
      }
      testID="approval-setup-screen"
    >
      <SetupBody person={person} phase={phase} owners={owners} dispatch={dispatch} />
    </AppShell>
  );
}

function SetupBody({
  person,
  phase,
  owners,
  dispatch,
}: {
  readonly person: PinEntryPerson;
  readonly phase: SetupPhase;
  readonly owners: readonly ConfirmingOwner[];
  readonly dispatch: (event: SetupEvent) => void;
}): React.JSX.Element {
  switch (phase.kind) {
    case 'chooseProof':
      return (
        <View testID="approval-setup-proofs">
          <Text style={styles.heading}>{t('auth.approval.setup.chooseProof')}</Text>
          {phase.kinds.map((kind) => (
            <ListRow
              key={kind}
              primaryText={t(`auth.approval.setup.proof.${kind}`)}
              secondaryText={t(`auth.approval.setup.proofHint.${kind}`)}
              onPress={() => dispatch({ kind: 'choseProof', proofKind: kind })}
              showChevron
              testID={`approval-setup-proof-${kind}`}
            />
          ))}
        </View>
      );
    case 'proof':
      return (
        <ProofStep
          person={person}
          proofKind={phase.proofKind}
          failure={
            phase.failure === null ? null : t(setupFailureKey(phase.failure, phase.proofKind))
          }
          tries={phase.tries}
          owners={owners}
          onProof={(proof) => dispatch({ kind: 'proved', proof })}
        />
      );
    case 'new':
    case 'saving': {
      const entry = phase.kind === 'new' ? phase.entry : null;
      const refused = phase.kind === 'new' ? (phase.failure ?? null) : null;
      const feedback =
        refused !== null
          ? setupFailureKey(refused, null)
          : entry === null
            ? null
            : setupNewFeedbackKey(entry);
      return (
        <PinEntry
          person={person}
          busyLabel={phase.kind === 'saving' ? t('auth.approval.setup.saving') : undefined}
          prompt={t(entry === null ? 'auth.approval.setup.repeat' : setupNewPromptKey(entry))}
          message={feedback === null ? undefined : t(feedback)}
          state={entry === null ? 'locked' : refused !== null ? 'error' : newPinPadState(entry)}
          onComplete={(pin) => dispatch({ kind: 'enteredNew', pin })}
          padKey={entry === null ? 'saving' : `new-${newPinPadKey(entry)}`}
          backspaceLabel={t('core.action.delete')}
          testID="approval-setup"
        />
      );
    }
    case 'done':
      return (
        <OutcomeState
          tone="success"
          icon="success"
          title={t('auth.approval.setup.done')}
          message={t('auth.approval.setup.doneBody')}
          testID="approval-setup-done"
        />
      );
  }
}

function ProofStep({
  person,
  proofKind,
  failure,
  tries,
  owners,
  onProof,
}: {
  readonly person: PinEntryPerson;
  readonly proofKind: ProofKind;
  readonly failure: string | null;
  readonly tries: number;
  readonly owners: readonly ConfirmingOwner[];
  readonly onProof: (proof: ApprovalPinProof) => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [ownerId, setOwnerId] = useState<string | null>(
    owners.length === 1 ? owners[0]!.userId : null,
  );
  if (proofKind === 'current') {
    return (
      <PinEntry
        person={person}
        prompt={t('auth.approval.setup.currentPrompt')}
        message={failure ?? undefined}
        state={failure === null ? 'entry' : 'error'}
        onComplete={(pin) => onProof({ kind: 'current', pin })}
        padKey={`current-${tries}`}
        backspaceLabel={t('core.action.delete')}
        testID="approval-setup-current"
      />
    );
  }
  if (proofKind === 'password') {
    return (
      <View style={styles.gap}>
        <Text style={styles.body}>{t('auth.approval.setup.proofHint.password')}</Text>
        <TextInput
          label={t('auth.approval.setup.passwordLabel')}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCorrect={false}
          autoCapitalize="none"
          autoFocus
          errorMessage={failure ?? undefined}
          testID="approval-setup-password"
        />
        <Button
          label={t('auth.approval.setup.next')}
          disabled={password === ''}
          onPress={() => onProof({ kind: 'password', password })}
          testID="approval-setup-password-next"
        />
      </View>
    );
  }
  if (owners.length === 0) {
    return (
      <OutcomeState
        tone="neutral"
        icon="lock"
        title={t('auth.approval.setup.proof.owner')}
        message={t('auth.approval.setup.noOwner')}
        testID="approval-setup-no-owner"
      />
    );
  }
  const owner = owners.find((candidate) => candidate.userId === ownerId) ?? null;
  if (owner === null) {
    return (
      <View testID="approval-setup-owners">
        <Text style={styles.body}>{t('auth.approval.setup.proofHint.owner')}</Text>
        {owners.map((candidate) => (
          <ListRow
            key={candidate.userId}
            primaryText={candidate.name}
            onPress={() => setOwnerId(candidate.userId)}
            showChevron
            testID={`approval-setup-owner-${candidate.userId}`}
          />
        ))}
      </View>
    );
  }
  return (
    <PinEntry
      person={{ id: owner.userId, name: owner.name }}
      prompt={t('auth.approval.setup.ownerPrompt', { name: owner.name })}
      message={failure ?? t('auth.approval.setup.proofHint.owner')}
      state={failure === null ? 'entry' : 'error'}
      onComplete={(pin) => onProof({ kind: 'owner', userId: owner.userId, pin })}
      padKey={`owner-${owner.userId}-${tries}`}
      backspaceLabel={t('core.action.delete')}
      testID="approval-setup-owner"
    />
  );
}

/** The phone's pad has no busy look: a check under way shows `busyLabel` instead of the pad. */
function padStateOf(state: 'entry' | 'error' | 'locked' | 'busy'): 'entry' | 'error' | 'locked' {
  return state === 'busy' ? 'locked' : state;
}

const styles = StyleSheet.create({
  gap: { gap: space.md },
  body: { ...typeScale.body, color: color.textMuted },
  heading: { ...typeScale.bodyBold, color: color.text, marginBottom: space.sm },
});
