/**
 * IntakeWizard — the counter's one-sitting intake as six short steps: customer, device, condition,
 * the six photos, price and ready date, then a review that opens the ticket. Every step keeps its
 * input in one draft, published on each change so an idle lock never loses a half-done intake
 * (SEC-AUTH-08, the same retention notes uses) and released only when the user saves or discards.
 */

import { ConfirmSheet, StepHeader, color, space, type } from '@bolusi/ui';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useActionRunner, type DiscardGuard, type StepBack } from '../../screen-kit/index.js';

import { tn, type RepairKey } from './i18n.js';
import { INTAKE_SLOT_KEY, INTAKE_STEP_KEY } from './labels.js';
import {
  INTAKE_STEPS,
  capturedThumbnailRef,
  emptyIntakeDraft,
  intakeDirty,
  nextMissingPhoto,
  stepProblems,
  toOpenTicketInput,
  type IntakeDraft,
  type IntakeProblem,
} from '../flows.js';
import { INTAKE_PHOTO_SLOTS, type IntakePhotoSlot } from '../constants.js';
import { FlowScreen, repairStyles, type RepairChrome } from './parts.js';
import { usePhotoBrowser } from './photos.js';
import { useRepairRuntime } from './runtime.js';

import {
  ConditionStep,
  CustomerStep,
  DeviceStep,
  PhotosStep,
  PriceStep,
  ReviewStep,
} from './IntakeSteps.js';

const PROBLEM_KEY: Readonly<Record<IntakeProblem, RepairKey>> = {
  customerName: 'repair.problem.customerName',
  deviceBrand: 'repair.problem.deviceBrand',
  deviceModel: 'repair.problem.deviceModel',
  complaint: 'repair.problem.complaint',
  photos: 'repair.problem.photos',
  quoteLines: 'repair.problem.quoteLines',
  incompleteLine: 'repair.problem.incompleteLine',
  negativeTotal: 'repair.problem.negativeTotal',
};

export interface IntakeWizardProps {
  readonly chrome: RepairChrome;
  /** Read when the ticket is opened, so a wizard left open for hours still dates it correctly. */
  readonly now: () => number;
  readonly restoredDraft?: IntakeDraft | null | undefined;
  readonly onDraftChange?: ((draft: IntakeDraft | null) => void) | undefined;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  /** Hardware back moves one step back; at the first step it is the surface's leave (with confirm). */
  readonly onRegisterStepBack?: ((back: StepBack | null) => void) | undefined;
  readonly onOpened: (ticketId: string) => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

export function IntakeWizard({
  chrome,
  now,
  restoredDraft,
  onDraftChange,
  onRegisterDiscardGuard,
  onRegisterStepBack,
  onOpened,
  onCancel,
  testID = 'repair.intake',
}: IntakeWizardProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [draft, setDraft] = useState<IntakeDraft>(() => restoredDraft ?? emptyIntakeDraft());
  const [showProblems, setShowProblems] = useState(false);
  const [restoredOnce] = useState(restoredDraft ?? null);
  const [photosExpired, setPhotosExpired] = useState(false);

  // A draft kept across a lock can outlive its photos: a capture no saved ticket refers to is
  // deleted a day after it was taken (06 §7). Restored photos that no longer load are dropped, so
  // the photo walk asks for them again instead of opening a ticket whose evidence is gone.
  useEffect(() => {
    if (restoredOnce === null) return;
    let live = true;
    const checks = Object.values(restoredOnce.photos).map(async (ref) => {
      if (ref === undefined) return null;
      const state = await runtime
        .loadThumbnail(capturedThumbnailRef(ref))
        .catch(() => ({ kind: 'unavailable' }) as const);
      return state.kind === 'ready' ? null : ref.mediaId;
    });
    void Promise.all(checks).then((results) => {
      const gone = new Set(results.filter((id): id is string => id !== null));
      if (!live || gone.size === 0) return;
      setDraft((d) => ({
        ...d,
        photos: Object.fromEntries(
          Object.entries(d.photos).filter(([, ref]) => ref === undefined || !gone.has(ref.mediaId)),
        ),
      }));
      setPhotosExpired(true);
    });
    return () => {
      live = false;
    };
  }, [restoredOnce, runtime]);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  const stepIndex = Math.min(draft.step, INTAKE_STEPS.length - 1);
  const step = INTAKE_STEPS[stepIndex]!;
  const problems = stepProblems(draft, step);
  const dirty = intakeDirty(draft);
  const update = (patch: Partial<IntakeDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  // The review shows the photos as a strip that opens full screen, like a saved ticket.
  const photos = usePhotoBrowser(
    useMemo(
      () =>
        INTAKE_PHOTO_SLOTS.flatMap((slot) => {
          const ref = draft.photos[slot];
          return ref === undefined
            ? []
            : [
                {
                  key: slot,
                  label: tn(INTAKE_SLOT_KEY[slot]),
                  group: tn('repair.photo.intake'),
                  ref: capturedThumbnailRef(ref),
                },
              ];
        }),
      [draft.photos],
    ),
    `${testID}.review.photos`,
  );

  // Write-through retention: every change, never on unmount (an unmount is what a lock looks like).
  useEffect(() => {
    onDraftChange?.(dirty ? draft : null);
  }, [dirty, draft, onDraftChange]);

  const requestLeave = (proceed: () => void): void => {
    if (!dirty) {
      onDraftChange?.(null);
      proceed();
      return;
    }
    setPendingLeave(() => proceed);
  };

  useEffect(() => {
    onRegisterDiscardGuard?.((proceed) => {
      if (!dirty) {
        onDraftChange?.(null);
        proceed();
        return;
      }
      setPendingLeave(() => proceed);
    });
    return () => onRegisterDiscardGuard?.(null);
  }, [dirty, onRegisterDiscardGuard, onDraftChange]);

  const goTo = (index: number): void => {
    setShowProblems(false);
    update({ step: index });
  };

  useEffect(() => {
    onRegisterStepBack?.(() => {
      if (photos.back()) return true;
      if (stepIndex === 0) return false;
      goTo(stepIndex - 1);
      return true;
    });
    return () => onRegisterStepBack?.(null);
  });

  const takePhoto = (slot: IntakePhotoSlot): void => {
    void runner
      .run(() => runtime.capturePhoto({ title: tn(INTAKE_SLOT_KEY[slot]) }))
      .then((captured) => {
        if (captured === undefined || captured === null) return;
        setDraft((d) => ({ ...d, photos: { ...d.photos, [slot]: captured.mediaRef } }));
      });
  };
  // On the photos step the primary action walks round the phone: it takes the next missing shot.
  const missingPhoto = step === 'photos' ? nextMissingPhoto(draft) : null;

  const next = (): void => {
    if (missingPhoto !== null) {
      takePhoto(missingPhoto);
      return;
    }
    if (problems.length > 0) {
      setShowProblems(true);
      return;
    }
    if (step !== 'review') {
      goTo(stepIndex + 1);
      return;
    }
    void runner
      .run(() => runtime.run('openTicket', toOpenTicketInput(draft, now())))
      .then((opened) => {
        if (opened === undefined) return;
        onDraftChange?.(null);
        onOpened(opened.ticketId);
      });
  };

  const back = (): void => (stepIndex === 0 ? requestLeave(onCancel) : goTo(stepIndex - 1));
  const problemText = (problem: IntakeProblem): string | undefined =>
    showProblems && problems.includes(problem) ? tn(PROBLEM_KEY[problem]) : undefined;

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.action.newIntake')}
      onBack={back}
      primaryLabel={
        missingPhoto !== null
          ? tn('repair.photo.takeNext', { slot: tn(INTAKE_SLOT_KEY[missingPhoto]) })
          : step === 'review'
            ? tn('repair.action.openTicket')
            : tn('repair.action.next')
      }
      onPrimary={next}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      overlay={
        pendingLeave === null ? (
          photos.overlay
        ) : (
          <ConfirmSheet
            title={tn('repair.intake.discardTitle')}
            message={tn('repair.intake.discardMessage')}
            confirmLabel={tn('repair.intake.discard')}
            onConfirm={() => {
              const proceed = pendingLeave;
              setPendingLeave(null);
              onDraftChange?.(null);
              proceed();
            }}
            cancelLabel={tn('repair.intake.keepEditing')}
            onCancel={() => setPendingLeave(null)}
            testID={`${testID}.discard`}
          />
        )
      }
      testID={testID}
    >
      <StepHeader
        step={stepIndex + 1}
        total={INTAKE_STEPS.length}
        progressLabel={tn('repair.intake.progress', {
          step: stepIndex + 1,
          total: INTAKE_STEPS.length,
        })}
        title={tn(INTAKE_STEP_KEY[step])}
        testID={`${testID}.header`}
      />
      <View style={styles.body} testID={`${testID}.step.${step}`}>
        {photosExpired && step === 'photos' ? (
          <Text style={[repairStyles.warning, styles.check]} testID={`${testID}.photosExpired`}>
            {tn('repair.photo.expired')}
          </Text>
        ) : null}
        {renderStep()}
      </View>
      {showProblems && (step === 'photos' || step === 'price' || step === 'review') ? (
        <View style={repairStyles.gap}>
          {/* A line's own problem shows on its field, so only step-wide ones are listed here. */}
          {problems
            .filter((problem) => problem !== 'incompleteLine')
            .map((problem) => (
              <Text key={problem} style={styles.problem} testID={`${testID}.problem.${problem}`}>
                {tn(PROBLEM_KEY[problem])}
              </Text>
            ))}
        </View>
      ) : null}
    </FlowScreen>
  );

  function renderStep(): React.JSX.Element {
    switch (step) {
      case 'customer':
        return (
          <CustomerStep
            draft={draft}
            update={update}
            nameError={problemText('customerName')}
            testID={`${testID}.customer`}
          />
        );
      case 'device':
        return (
          <DeviceStep
            draft={draft}
            update={update}
            brandError={problemText('deviceBrand')}
            modelError={problemText('deviceModel')}
            testID={`${testID}.device`}
          />
        );
      case 'condition':
        return (
          <ConditionStep
            draft={draft}
            update={update}
            complaintError={problemText('complaint')}
            testID={`${testID}.condition`}
          />
        );
      case 'photos':
        return <PhotosStep draft={draft} onTake={takePhoto} testID={`${testID}.photos`} />;
      case 'price':
        return (
          <PriceStep
            draft={draft}
            update={update}
            lineError={problemText('incompleteLine')}
            testID={`${testID}.price`}
          />
        );
      case 'review':
        return (
          <ReviewStep
            draft={draft}
            onEdit={goTo}
            photoStrip={photos.strip}
            testID={`${testID}.review`}
          />
        );
    }
  }
}

const styles = StyleSheet.create({
  body: { marginTop: space.lg },
  problem: { ...type.bodySm, color: color.danger, marginBottom: space.xs },
  check: { marginBottom: space.md },
});
