// The approval PIN's two flows, shared by the phone and the PC (owner decision 2026-11-25):
//
// - asking for it when a decision on a shared device needs it (`AskPhase`), which opens a decision
//   session for ten minutes (device person-access.ts `openDecision`);
// - setting it (`SetupPhase`): the proof the server asks for off the person's own phone, then the
//   new PIN twice (`new-pin.ts`, which refuses an easy one at once).
//
// Copy-free and React-free: the screens map phases to catalog keys and pads. The PINs and the
// password live only in these in-memory values while they are typed, and leave as the submit.
import type { ApprovalPinFailure, ApprovalPinProof } from '@bolusi/core';

import type { DecisionOpening } from '../../bootstrap/person-access.js';
import { advanceNewPin, NEW_PIN_START, type NewPinEntry } from '../pin/new-pin.js';

// ── Asking for it ───────────────────────────────────────────────────────────────────────────────

export type AskFeedback = Exclude<DecisionOpening, 'opened' | 'notSet'>;

export type AskPhase =
  | { readonly kind: 'enter'; readonly feedback: AskFeedback | null; readonly tries: number }
  | { readonly kind: 'checking'; readonly pin: string; readonly tries: number }
  /** They have none yet: the screen offers to make one (`SetupPhase`). */
  | { readonly kind: 'notSet' }
  /** A decision session opened. Terminal: the screen resolves and closes. */
  | { readonly kind: 'opened' };

export const ASK_START: AskPhase = { kind: 'enter', feedback: null, tries: 0 };

export type AskEvent =
  | { readonly kind: 'entered'; readonly pin: string }
  | { readonly kind: 'checked'; readonly outcome: DecisionOpening };

export function askReducer(phase: AskPhase, event: AskEvent): AskPhase {
  if (phase.kind === 'enter' && event.kind === 'entered') {
    // Locked stays locked here: the server would only refuse again until the window passes.
    if (phase.feedback === 'locked') return phase;
    return { kind: 'checking', pin: event.pin, tries: phase.tries };
  }
  if (phase.kind === 'checking' && event.kind === 'checked') {
    if (event.outcome === 'opened') return { kind: 'opened' };
    if (event.outcome === 'notSet') return { kind: 'notSet' };
    return { kind: 'enter', feedback: event.outcome, tries: phase.tries + 1 };
  }
  return phase;
}

/** The line under the pad while asking: why the last try did not open one. */
export function askFeedbackKey(
  phase: AskPhase,
):
  | 'auth.approval.ask.wrong'
  | 'auth.approval.ask.locked'
  | 'auth.approval.ask.offline'
  | 'auth.approval.ask.failed'
  | 'auth.approval.ask.checking'
  | null {
  if (phase.kind === 'checking') return 'auth.approval.ask.checking';
  if (phase.kind !== 'enter' || phase.feedback === null) return null;
  return `auth.approval.ask.${phase.feedback}`;
}

export function askPadState(phase: AskPhase): 'entry' | 'error' | 'locked' | 'busy' {
  if (phase.kind === 'checking') return 'busy';
  if (phase.kind !== 'enter') return 'busy';
  if (phase.feedback === 'locked') return 'locked';
  return phase.feedback === null ? 'entry' : 'error';
}

/** A fresh pad after each try, so its dots clear. */
export function askPadKey(phase: AskPhase): string {
  return phase.kind === 'enter' || phase.kind === 'checking' ? `ask-${phase.tries}` : phase.kind;
}

// ── Setting it ──────────────────────────────────────────────────────────────────────────────────

/** How the person proves it is them, beyond being signed in (server auth/approval-pins.ts). */
export type ProofKind = ApprovalPinProof['kind'];

/**
 * The proofs this person can give here: none on their own phone; else their current approval PIN
 * (when changing one), their account password (the main owner has one), or an owner confirming.
 */
export function proofKindsFor(input: {
  readonly personalDevice: boolean;
  readonly tenantAdmin: boolean;
  /** False when they surely have none yet (a decision just said so). */
  readonly mayHaveOne: boolean;
}): readonly ProofKind[] {
  if (input.personalDevice) return [];
  const forgotten: ProofKind = input.tenantAdmin ? 'password' : 'owner';
  return input.mayHaveOne ? ['current', forgotten] : [forgotten];
}

export type SetupFailure = ApprovalPinFailure;

export type SetupPhase =
  /** Choosing how to prove it (shown only when there is more than one way). */
  | { readonly kind: 'chooseProof'; readonly kinds: readonly ProofKind[] }
  /** Giving the proof: the current approval PIN, the password, or an owner and their PIN. */
  | {
      readonly kind: 'proof';
      readonly proofKind: ProofKind;
      readonly failure: SetupFailure | null;
      readonly tries: number;
    }
  | {
      readonly kind: 'new';
      readonly proof: ApprovalPinProof | null;
      readonly entry: NewPinEntry;
      readonly tries: number;
      /** Why the last save on one's own phone did not go through (it has no proof step). */
      readonly failure?: SetupFailure | null;
    }
  | {
      readonly kind: 'saving';
      readonly proof: ApprovalPinProof | null;
      readonly pin: string;
      /** Saves the server refused so far, so each refusal shows a fresh pad. */
      readonly tries: number;
    }
  /**
   * Saved. Terminal. `approved` is whether the decision that asked may go ahead: from Settings
   * always, from a decision only once a session opened with the new PIN.
   */
  | { readonly kind: 'done'; readonly pin: string; readonly approved: boolean };

export function setupStart(kinds: readonly ProofKind[]): SetupPhase {
  if (kinds.length === 0) return { kind: 'new', proof: null, entry: NEW_PIN_START, tries: 0 };
  if (kinds.length === 1) return { kind: 'proof', proofKind: kinds[0]!, failure: null, tries: 0 };
  return { kind: 'chooseProof', kinds };
}

export type SetupEvent =
  | { readonly kind: 'choseProof'; readonly proofKind: ProofKind }
  | { readonly kind: 'proved'; readonly proof: ApprovalPinProof }
  | { readonly kind: 'enteredNew'; readonly pin: string }
  | { readonly kind: 'saved'; readonly approved: boolean }
  | { readonly kind: 'failed'; readonly failure: SetupFailure };

export function setupReducer(phase: SetupPhase, event: SetupEvent): SetupPhase {
  switch (phase.kind) {
    case 'chooseProof':
      return event.kind === 'choseProof' && phase.kinds.includes(event.proofKind)
        ? { kind: 'proof', proofKind: event.proofKind, failure: null, tries: 0 }
        : phase;
    case 'proof':
      return event.kind === 'proved' && event.proof.kind === phase.proofKind
        ? { kind: 'new', proof: event.proof, entry: NEW_PIN_START, tries: phase.tries }
        : phase;
    case 'new': {
      if (event.kind !== 'enteredNew') return phase;
      const entry = advanceNewPin(phase.entry, event.pin);
      return entry.kind === 'matched'
        ? { kind: 'saving', proof: phase.proof, pin: entry.pin, tries: phase.tries }
        : { kind: 'new', proof: phase.proof, entry, tries: phase.tries };
    }
    case 'saving':
      if (event.kind === 'saved') return { kind: 'done', pin: phase.pin, approved: event.approved };
      if (event.kind !== 'failed') return phase;
      return afterRefusal(phase, event.failure);
    case 'done':
      return phase;
  }
}

/**
 * Where a refused save goes back to: the new PIN when the server refused the PIN itself (or on
 * one's own phone, where there is no proof), else the proof, with why.
 */
function afterRefusal(
  phase: Extract<SetupPhase, { kind: 'saving' }>,
  failure: SetupFailure,
): SetupPhase {
  const tries = phase.tries + 1;
  if (failure === 'weakPin') {
    const entry: NewPinEntry = { kind: 'first', problem: 'weak', refusals: tries };
    return { kind: 'new', proof: phase.proof, entry, tries };
  }
  if (phase.proof === null) {
    const entry: NewPinEntry = { kind: 'first', problem: null, refusals: tries };
    return { kind: 'new', proof: null, entry, tries, failure };
  }
  return { kind: 'proof', proofKind: phase.proof.kind, failure, tries };
}

/** Why the proof step is shown again, as the line under it. */
export function setupFailureKey(
  failure: SetupFailure,
  proofKind: ProofKind | null,
):
  | 'auth.approval.setup.wrongCurrent'
  | 'auth.approval.setup.wrongPassword'
  | 'auth.approval.setup.wrongOwner'
  | 'auth.approval.setup.offline'
  | 'auth.approval.setup.denied'
  | 'auth.approval.setup.rateLimited'
  | 'auth.approval.setup.failed' {
  if (failure === 'wrongProof') {
    if (proofKind === 'current') return 'auth.approval.setup.wrongCurrent';
    if (proofKind === 'password') return 'auth.approval.setup.wrongPassword';
    return 'auth.approval.setup.wrongOwner';
  }
  if (failure === 'offline') return 'auth.approval.setup.offline';
  if (failure === 'denied') return 'auth.approval.setup.denied';
  if (failure === 'rateLimited') return 'auth.approval.setup.rateLimited';
  return 'auth.approval.setup.failed';
}

/** What the finished step says: saved, and whether the decision that asked went ahead. */
export function setupDoneKey(
  phase: Extract<SetupPhase, { kind: 'done' }>,
): 'auth.approval.setup.doneBody' | 'auth.approval.setup.doneNotApproved' {
  return phase.approved ? 'auth.approval.setup.doneBody' : 'auth.approval.setup.doneNotApproved';
}

/** The new PIN step's question and tip, in the approval PIN's own words. */
export function setupNewPromptKey(
  entry: NewPinEntry,
): 'auth.approval.setup.new' | 'auth.approval.setup.repeat' {
  return entry.kind === 'repeat' ? 'auth.approval.setup.repeat' : 'auth.approval.setup.new';
}

export function setupNewFeedbackKey(
  entry: NewPinEntry,
): 'auth.approval.setup.hint' | 'auth.approval.setup.weak' | 'auth.approval.setup.mismatch' | null {
  if (entry.kind !== 'first') return null;
  if (entry.problem === 'weak') return 'auth.approval.setup.weak';
  if (entry.problem === 'mismatch') return 'auth.approval.setup.mismatch';
  return 'auth.approval.setup.hint';
}
