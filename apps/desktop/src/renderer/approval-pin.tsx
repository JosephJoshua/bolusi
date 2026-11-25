// The approval PIN on the counter PC (owner decision 2026-11-25): asked when an owner's or
// manager's decision needs it, and set or changed from Settings › Akun. Only the server checks it,
// so every step here is online; the flows are the phone's (device models/approval-pin).
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
  type SetupFailure,
  type SetupPhase,
} from '@bolusi/device/models/approval-pin/model';
import { newPinPadKey, newPinPadState } from '@bolusi/device/models/pin/new-pin';
import { t } from '@bolusi/i18n';
import { Button, Card, ChoiceList, Dialog, SecretField } from '@bolusi/ui-web';
import { CircleCheck, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { PinSteps } from './settings/AccountPanel.js';

/** Someone who may confirm a colleague's approval PIN here (an owner signed in on this PC). */
export interface ConfirmingOwner {
  readonly userId: string;
  readonly name: string;
}

export interface ApprovalPinPort {
  /** Open a decision session with the signed-in person's approval PIN. */
  readonly open: (approvalPin: string) => Promise<DecisionOpening>;
  /** Set their own; REJECTS with a `StaffAdminError`. */
  readonly set: (pin: string, proof: ApprovalPinProof | undefined) => Promise<void>;
}

interface Person {
  readonly userId: string;
  readonly name: string;
}

/**
 * The prompt a decision waits on: `ask` shows it and resolves whether a decision session opened.
 * One at a time; a second ask while one is open shares its answer.
 */
export function useDecisionPrompt(input: {
  readonly person: Person;
  readonly port: ApprovalPinPort;
  readonly proofKinds: readonly ProofKind[];
  readonly owners: readonly ConfirmingOwner[];
}): { readonly ask: () => Promise<boolean>; readonly prompt: React.JSX.Element | null } {
  const [open, setOpen] = useState(false);
  const pending = useRef<{ promise: Promise<boolean>; resolve: (opened: boolean) => void } | null>(
    null,
  );
  const ask = useCallback((): Promise<boolean> => {
    if (pending.current !== null) return pending.current.promise;
    let resolve: (opened: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((done) => (resolve = done));
    pending.current = { promise, resolve };
    setOpen(true);
    return promise;
  }, []);
  const finish = useCallback((opened: boolean) => {
    const current = pending.current;
    pending.current = null;
    setOpen(false);
    current?.resolve(opened);
  }, []);
  // Leaving the screen (a lock, a switch) answers "not approved".
  useEffect(() => () => pending.current?.resolve(false), []);
  return {
    ask,
    prompt: open ? (
      <ApprovalPinAskDialog
        person={input.person}
        port={input.port}
        proofKinds={input.proofKinds}
        owners={input.owners}
        onDone={finish}
      />
    ) : null,
  };
}

function ApprovalPinAskDialog({
  person,
  port,
  proofKinds,
  owners,
  onDone,
}: {
  readonly person: Person;
  readonly port: ApprovalPinPort;
  readonly proofKinds: readonly ProofKind[];
  readonly owners: readonly ConfirmingOwner[];
  readonly onDone: (opened: boolean) => void;
}): React.JSX.Element {
  const [phase, dispatch] = useReducer(askReducer, ASK_START);
  const [settingUp, setSettingUp] = useState(false);
  const portRef = useRef(port);
  portRef.current = port;

  useEffect(() => {
    if (phase.kind !== 'checking') return;
    let cancelled = false;
    void portRef.current.open(phase.pin).then(
      (outcome) => !cancelled && dispatch({ kind: 'checked', outcome }),
      () => !cancelled && dispatch({ kind: 'checked', outcome: 'failed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [phase]);

  useEffect(() => {
    if (phase.kind === 'opened') onDone(true);
  }, [phase, onDone]);

  if (settingUp) {
    return (
      <ApprovalPinSetupDialog
        person={person}
        port={port}
        // They have none: their current one is no proof.
        proofKinds={proofKinds.filter((kind) => kind !== 'current')}
        owners={owners}
        openAfter
        onClose={(saved) => onDone(saved)}
      />
    );
  }

  const busy = phase.kind === 'checking';
  const feedback = askFeedbackKey(phase);
  return (
    <Dialog
      open
      onRequestClose={() => (busy ? undefined : onDone(false))}
      title={
        phase.kind === 'notSet' ? t('auth.approval.ask.notSetTitle') : t('auth.approval.ask.title')
      }
      description={phase.kind === 'notSet' ? undefined : t('auth.approval.ask.body')}
      closeLabel={t('core.action.close')}
      size="sm"
      testId="desktop.approvalAsk"
      footer={
        phase.kind === 'notSet' ? (
          <>
            <Button label={t('core.action.cancel')} onClick={() => onDone(false)} />
            <Button
              label={t('auth.approval.ask.create')}
              variant="primary"
              autoFocus
              onClick={() => setSettingUp(true)}
              data-testid="desktop.approvalAsk.create"
            />
          </>
        ) : undefined
      }
    >
      {phase.kind === 'notSet' ? (
        <p className="text-body text-text" data-testid="desktop.approvalAsk.notSet">
          {t('auth.approval.ask.notSetBody')}
        </p>
      ) : (
        <PinSteps
          person={person}
          prompt={t('auth.approval.ask.prompt')}
          message={feedback === null ? undefined : t(feedback)}
          danger={phase.kind === 'enter' && phase.feedback !== null}
          padState={askPadState(phase)}
          padKey={askPadKey(phase)}
          onComplete={(pin) => dispatch({ kind: 'entered', pin })}
          testId="desktop.approvalAsk"
        />
      )}
    </Dialog>
  );
}

/** Settings › Akun: what the approval PIN is for, and setting or changing it. */
export function ApprovalPinCard({
  person,
  port,
  proofKinds,
  owners,
}: {
  readonly person: Person;
  readonly port: ApprovalPinPort;
  readonly proofKinds: readonly ProofKind[];
  readonly owners: readonly ConfirmingOwner[];
}): React.JSX.Element {
  const [setting, setSetting] = useState(false);
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-alt text-text-muted">
            <ShieldCheck size={18} aria-hidden />
          </span>
          <div className="flex min-w-0 flex-col">
            <p className="text-body font-semibold text-text">{t('auth.approval.title')}</p>
            <p className="text-small text-text-muted">{t('auth.approval.summary')}</p>
          </div>
        </div>
        <Button
          label={t('auth.approval.set')}
          onClick={() => setSetting(true)}
          data-testid="desktop.settings.approvalPin"
        />
      </div>
      {setting ? (
        <ApprovalPinSetupDialog
          person={person}
          port={port}
          proofKinds={proofKinds}
          owners={owners}
          onClose={() => setSetting(false)}
        />
      ) : null}
    </Card>
  );
}

/**
 * Setting the approval PIN: the proof the server asks for here, then the new PIN twice. With
 * `openAfter` (asked by a decision), the new PIN opens a decision session at once.
 */
export function ApprovalPinSetupDialog({
  person,
  port,
  proofKinds,
  owners,
  openAfter = false,
  onClose,
}: {
  readonly person: Person;
  readonly port: ApprovalPinPort;
  readonly proofKinds: readonly ProofKind[];
  readonly owners: readonly ConfirmingOwner[];
  readonly openAfter?: boolean;
  readonly onClose: (saved: boolean) => void;
}): React.JSX.Element {
  const [phase, dispatch] = useReducer(setupReducer, proofKinds, setupStart);
  const portRef = useRef(port);
  portRef.current = port;

  useEffect(() => {
    if (phase.kind !== 'saving') return;
    let cancelled = false;
    void (async () => {
      try {
        await portRef.current.set(phase.pin, phase.proof ?? undefined);
      } catch (error) {
        if (!cancelled) dispatch({ kind: 'failed', failure: approvalPinFailure(error) });
        return;
      }
      if (openAfter) await portRef.current.open(phase.pin).catch(() => 'failed' as const);
      if (!cancelled) dispatch({ kind: 'saved' });
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, openAfter]);

  const saving = phase.kind === 'saving';
  const done = phase.kind === 'done';
  return (
    <Dialog
      open
      onRequestClose={() => (saving ? undefined : onClose(done))}
      title={t('auth.approval.setup.title')}
      closeLabel={t('core.action.close')}
      size="sm"
      testId="desktop.approvalSetup"
      footer={
        done ? (
          <Button
            label={t('auth.pin.staff.finish')}
            variant="primary"
            autoFocus
            onClick={() => onClose(true)}
            data-testid="desktop.approvalSetup.finish"
          />
        ) : undefined
      }
    >
      <SetupBody person={person} phase={phase} owners={owners} dispatch={dispatch} />
    </Dialog>
  );
}

function SetupBody({
  person,
  phase,
  owners,
  dispatch,
}: {
  readonly person: Person;
  readonly phase: SetupPhase;
  readonly owners: readonly ConfirmingOwner[];
  readonly dispatch: React.Dispatch<Parameters<typeof setupReducer>[1]>;
}): React.JSX.Element {
  switch (phase.kind) {
    case 'chooseProof':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-body font-semibold text-text">
            {t('auth.approval.setup.chooseProof')}
          </p>
          <ChoiceList
            label={t('auth.approval.setup.chooseProof')}
            options={phase.kinds.map((kind) => ({
              value: kind,
              label: t(`auth.approval.setup.proof.${kind}`),
            }))}
            value={null}
            onChange={(proofKind) => dispatch({ kind: 'choseProof', proofKind })}
            testId="desktop.approvalSetup.proofs"
          />
        </div>
      );
    case 'proof':
      return (
        <ProofStep
          person={person}
          proofKind={phase.proofKind}
          failure={phase.failure}
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
        <PinSteps
          person={person}
          prompt={t(entry === null ? 'auth.approval.setup.repeat' : setupNewPromptKey(entry))}
          message={
            phase.kind === 'saving'
              ? t('auth.approval.setup.saving')
              : feedback === null
                ? undefined
                : t(feedback)
          }
          danger={refused !== null || (entry !== null && newPinPadState(entry) === 'error')}
          padState={entry === null ? 'busy' : newPinPadState(entry)}
          padKey={entry === null ? 'saving' : `new-${newPinPadKey(entry)}`}
          onComplete={(pin) => dispatch({ kind: 'enteredNew', pin })}
          testId="desktop.approvalSetup"
        />
      );
    }
    case 'done':
      return (
        <div
          className="flex flex-col items-center gap-2 py-4 text-center"
          data-testid="desktop.approvalSetup.done"
        >
          <CircleCheck size={40} strokeWidth={1.5} aria-hidden className="text-success" />
          <p className="text-heading font-semibold text-text">{t('auth.approval.setup.done')}</p>
          <p className="text-body text-text-muted">{t('auth.approval.setup.doneBody')}</p>
        </div>
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
  readonly person: Person;
  readonly proofKind: ProofKind;
  readonly failure: SetupFailure | null;
  readonly tries: number;
  readonly owners: readonly ConfirmingOwner[];
  readonly onProof: (proof: ApprovalPinProof) => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [ownerId, setOwnerId] = useState<string | null>(
    owners.length === 1 ? owners[0]!.userId : null,
  );
  const message = failure === null ? undefined : t(setupFailureKey(failure, proofKind));
  if (proofKind === 'current') {
    return (
      <PinSteps
        person={person}
        prompt={t('auth.approval.setup.currentPrompt')}
        message={message}
        danger={failure !== null}
        padState={failure === null ? 'entry' : 'error'}
        padKey={`current-${tries}`}
        onComplete={(pin) => onProof({ kind: 'current', pin })}
        testId="desktop.approvalSetup.current"
      />
    );
  }
  if (proofKind === 'password') {
    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (password !== '') onProof({ kind: 'password', password });
        }}
      >
        <p className="text-body text-text-muted">{t('auth.approval.setup.proofHint.password')}</p>
        <SecretField
          label={t('auth.approval.setup.passwordLabel')}
          showLabel={t('auth.pc.showPassword')}
          hideLabel={t('auth.pc.hidePassword')}
          value={password}
          maxLength={128}
          autoFocus
          error={message}
          onChange={(event) => setPassword(event.target.value)}
          data-testid="desktop.approvalSetup.password"
        />
        <div className="flex justify-end">
          <Button
            type="submit"
            label={t('auth.approval.setup.next')}
            variant="primary"
            disabled={password === ''}
            data-testid="desktop.approvalSetup.passwordNext"
          />
        </div>
      </form>
    );
  }
  if (owners.length === 0) {
    return (
      <p className="text-body text-text" data-testid="desktop.approvalSetup.noOwner">
        {t('auth.approval.setup.noOwner')}
      </p>
    );
  }
  const owner = owners.find((candidate) => candidate.userId === ownerId) ?? null;
  if (owner === null) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-body text-text-muted">{t('auth.approval.setup.proofHint.owner')}</p>
        <ChoiceList
          label={t('auth.approval.setup.ownerLabel')}
          options={owners.map((candidate) => ({ value: candidate.userId, label: candidate.name }))}
          value={null}
          onChange={setOwnerId}
          testId="desktop.approvalSetup.owners"
        />
      </div>
    );
  }
  return (
    <PinSteps
      person={{ userId: owner.userId, name: owner.name }}
      prompt={t('auth.approval.setup.ownerPrompt', { name: owner.name })}
      message={message ?? t('auth.approval.setup.proofHint.owner')}
      danger={failure !== null}
      padState={failure === null ? 'entry' : 'error'}
      padKey={`owner-${owner.userId}-${tries}`}
      onComplete={(pin) => onProof({ kind: 'owner', userId: owner.userId, pin })}
      testId="desktop.approvalSetup.owner"
    />
  );
}
