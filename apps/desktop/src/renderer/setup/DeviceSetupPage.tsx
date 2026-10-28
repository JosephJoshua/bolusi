// The first run of a newly registered PC, for the owner who registered it: the printer and paper
// with a test page, then a look at the webcam (or how photos and signatures come from a store phone
// instead), then what is ready. Every step is the PC's own setting, reused from Settings, and none
// blocks: "Nanti saja" ends it, and a PC without a printer keeps saying so in the title bar.
import { t } from '@bolusi/i18n';
import {
  DESK_PAPERS,
  paperLabel,
  PrintSettings,
  STORE_BASIC_KEY,
  STORE_BASIC_SETTING,
  tn,
  useDevicePaper,
  useDevicePrinters,
  useMissingStoreBasics,
  useRepairRuntime,
} from '@bolusi/modules/repair/desktop';
import {
  Button,
  Card,
  CameraPreview,
  Fact,
  FactGrid,
  PageHeader,
  Section,
  type WebcamState,
} from '@bolusi/ui-web';
import { ChevronRight, CircleCheck, PenLine, Smartphone } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { hasTouch, hasWebcam } from '../capture-dialogs.js';
import { StartWithWindows } from '../startup.js';

const STEPS = ['printer', 'capture'] as const;
type Step = (typeof STEPS)[number] | 'done';

/** Where photos come from: this PC's webcam, a store phone, or not known yet. */
type PhotoSource = 'webcam' | 'phone' | null;

/** Where a missing store basic is filled in, in Settings. */
export type StoreBasicSetting = 'slip' | 'paymentMethods';

export function DeviceSetupPage({
  onDone,
  onOpenSetting,
}: {
  readonly onDone: () => void;
  /** Finishes the setup and opens the setting that fills a missing store basic. */
  readonly onOpenSetting: (setting: StoreBasicSetting) => void;
}): React.JSX.Element {
  const [step, setStep] = useState<Step>('printer');
  const [photos, setPhotos] = useState<PhotoSource>(null);
  const index = step === 'done' ? -1 : STEPS.indexOf(step);

  if (step === 'done') {
    return <Ready photos={photos} onStart={onDone} onOpenSetting={onOpenSetting} />;
  }

  return (
    <>
      <PageHeader
        title={t('auth.pc.setup.title')}
        actions={
          <Button
            label={t('auth.pc.setup.later')}
            variant="text"
            onClick={onDone}
            data-testid="desktop.setup.later"
          />
        }
      />
      <div
        className="min-h-0 flex-1 overflow-y-auto border-t border-border px-6"
        data-testid={`desktop.setup.${step}`}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 py-6">
          <p className="text-small font-semibold text-text-muted" data-testid="desktop.setup.step">
            {t('auth.pc.setup.step', { step: index + 1, total: STEPS.length })}
          </p>
          {step === 'printer' ? <PrintSettings /> : <CaptureCheck onPhotos={setPhotos} />}
        </div>
      </div>
      <div className="shrink-0 border-t border-border bg-surface px-6 py-3">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-end gap-3">
          {index > 0 ? (
            <Button
              label={t('auth.pc.setup.back')}
              onClick={() => setStep(STEPS[index - 1]!)}
              data-testid="desktop.setup.back"
            />
          ) : null}
          <Button
            label={t('auth.pc.setup.next')}
            variant="primary"
            onClick={() => setStep(STEPS[index + 1] ?? 'done')}
            data-testid="desktop.setup.next"
          />
        </div>
      </div>
    </>
  );
}

/**
 * The webcam's live picture when Windows lists one, else how a store phone takes the photos; and
 * where the customer signs. The phone handoff itself starts at the first photo, not here: its
 * pairing ends after half an hour unused.
 */
function CaptureCheck({
  onPhotos,
}: {
  readonly onPhotos: (source: PhotoSource) => void;
}): React.JSX.Element {
  const [webcam, setWebcam] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<WebcamState['kind']>('starting');
  useEffect(() => {
    let live = true;
    void hasWebcam().then((found) => {
      if (live) setWebcam(found);
    });
    return () => {
      live = false;
    };
  }, []);
  const source: PhotoSource =
    webcam === null ? null : webcam && preview !== 'none' ? 'webcam' : 'phone';
  useEffect(() => onPhotos(source), [onPhotos, source]);
  const touch = hasTouch();

  return (
    <Card>
      <Section title={t('auth.pc.setup.cameraTitle')}>
        {webcam === null ? null : source === 'webcam' ? (
          <div className="flex flex-col gap-3">
            <p className="text-body text-text">{t('auth.pc.setup.cameraWebcam')}</p>
            <CameraPreview
              labels={{
                retry: t('core.action.retry'),
                starting: t('core.camera.starting'),
                none: t('core.camera.none'),
                denied: t('core.camera.denied'),
                failed: t('core.camera.failed'),
              }}
              onState={setPreview}
              testId="desktop.setup.camera"
            />
          </div>
        ) : (
          <Line icon={<Smartphone size={20} aria-hidden />} testId="desktop.setup.phone">
            {t('auth.pc.setup.cameraPhone')}
          </Line>
        )}
        <Line icon={<PenLine size={20} aria-hidden />} testId="desktop.setup.signature">
          {t(touch ? 'auth.pc.setup.signatureScreen' : 'auth.pc.setup.signaturePhone')}
        </Line>
      </Section>
    </Card>
  );
}

function Line({
  icon,
  children,
  testId,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <p className="flex items-start gap-3 text-body text-text" data-testid={testId}>
      <span className="mt-0.5 shrink-0 text-text-muted">{icon}</span>
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** What this PC is ready with, read back from its settings, and the way into the counter. */
function Ready({
  photos,
  onStart,
  onOpenSetting,
}: {
  readonly photos: PhotoSource;
  readonly onStart: () => void;
  readonly onOpenSetting: (setting: StoreBasicSetting) => void;
}): React.JSX.Element {
  const printing = useRepairRuntime().printing;
  const { paper } = useDevicePaper(printing, DESK_PAPERS);
  const { state } = useDevicePrinters(printing?.printers);
  const chosen =
    state.kind === 'ready' ? (state.printers.find((p) => p.name === state.chosen) ?? null) : null;
  const unpicked = printing?.printers !== undefined && state.kind === 'ready' && chosen === null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-12"
      data-testid="desktop.setup.done"
    >
      <div className="flex w-full max-w-xl flex-col items-center gap-6 text-center">
        <CircleCheck size={48} strokeWidth={1.5} aria-hidden className="text-success" />
        <h1 className="text-title font-bold text-text">{t('auth.pc.setup.doneTitle')}</h1>
        <Card className="w-full text-left">
          <FactGrid>
            {printing?.printers === undefined ? null : (
              <Fact
                label={t('auth.pc.setup.donePrinter')}
                value={
                  state.kind !== 'ready' ? '…' : (chosen?.label ?? t('auth.pc.setup.noPrinter'))
                }
                testId="desktop.setup.done.printer"
              />
            )}
            <Fact
              label={t('auth.pc.setup.donePaper')}
              value={paper === null ? '…' : paperLabel(paper)}
            />
            {photos === null ? null : (
              <Fact
                label={t('auth.pc.setup.donePhotos')}
                value={t(
                  photos === 'webcam' ? 'auth.pc.setup.viaWebcam' : 'auth.pc.setup.viaPhone',
                )}
                testId="desktop.setup.done.photos"
              />
            )}
            <Fact
              label={t('auth.pc.setup.doneSignature')}
              value={t(hasTouch() ? 'auth.pc.setup.viaScreen' : 'auth.pc.setup.viaPhone')}
            />
          </FactGrid>
        </Card>
        <StartWithWindows />
        {unpicked ? (
          <p className="text-body text-text-muted">{t('auth.pc.setup.laterHint')}</p>
        ) : null}
        <Button
          label={t('auth.pc.setup.start')}
          variant="primary"
          size="lg"
          className="w-full max-w-xs"
          onClick={onStart}
          autoFocus
          data-testid="desktop.setup.start"
        />
        {/* Below the start: filling these in is for whenever the owner has a moment. */}
        <StoreBasics onOpen={onOpenSetting} />
      </div>
    </div>
  );
}

/** What the store still lacks before its slips and payments are its own, each opening its setting. */
function StoreBasics({
  onOpen,
}: {
  readonly onOpen: (setting: StoreBasicSetting) => void;
}): React.JSX.Element | null {
  const missing = useMissingStoreBasics();
  if (missing === null || missing.length === 0) return null;
  return (
    <Section
      title={tn('repair.basics.title')}
      className="w-full pt-4 text-left"
      testId="desktop.setup.basics"
    >
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface">
        {missing.map((basic) => (
          <li key={basic}>
            <button
              type="button"
              onClick={() =>
                onOpen(STORE_BASIC_SETTING[basic] === 'printSettings' ? 'slip' : 'paymentMethods')
              }
              data-testid={`desktop.setup.basics.${basic}`}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-alt focus-visible:bg-surface-alt focus-visible:outline-none"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-body text-text">
                  {tn(STORE_BASIC_KEY[basic].title)}
                </span>
                <span className="block text-small text-text-muted">
                  {tn(STORE_BASIC_KEY[basic].summary)}
                </span>
              </span>
              <ChevronRight size={16} aria-hidden className="shrink-0 text-text-muted" />
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
