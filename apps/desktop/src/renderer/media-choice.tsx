// The camera and microphone this PC's photos and videos use: kept in the PC's settings file (main
// media-choice.ts), handed to every webcam dialog, and chosen in Settings or the setup guide with a
// live picture and a microphone level to check them.
import { t } from '@bolusi/i18n';
import {
  CameraPreview,
  Card,
  ChoiceList,
  findMediaInput,
  MicrophoneMeter,
  Section,
  useMediaInputs,
  WebcamChoiceProvider,
  type MediaInputChoice,
  type WebcamChoices,
  type WebcamState,
} from '@bolusi/ui-web';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { MediaBridge } from '../main/bridge.js';

export function mediaBridge(): MediaBridge | undefined {
  return (window as { bolusi?: { media?: MediaBridge } }).bolusi?.media;
}

interface MediaChoice {
  readonly choices: WebcamChoices;
  /** Absent where there is nowhere to keep a choice (the browser demo). */
  readonly choose?: ((kind: 'camera' | 'microphone', choice: MediaInputChoice) => void) | undefined;
}

const NONE: WebcamChoices = { camera: null, microphone: null };
const MediaChoiceContext = createContext<MediaChoice>({ choices: NONE });

/** Reads this PC's choice once and gives it to every webcam dialog below. */
export function MediaChoiceProvider({
  media = mediaBridge(),
  children,
}: {
  readonly media?: MediaBridge | undefined;
  readonly children: ReactNode;
}): React.JSX.Element {
  const [choices, setChoices] = useState<WebcamChoices>(NONE);
  useEffect(() => {
    if (media === undefined) return;
    let live = true;
    media.choices().then(
      (saved) => {
        if (live) setChoices(saved);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [media]);
  const value = useMemo(
    (): MediaChoice => ({
      choices,
      choose:
        media === undefined
          ? undefined
          : (kind, choice) => {
              // Shown at once; a failed save is undone so the page says what the file holds.
              const before = choices;
              setChoices((current) => ({ ...current, [kind]: choice }));
              media.choose(kind, choice).catch(() => setChoices(before));
            },
    }),
    [choices, media],
  );
  return (
    <MediaChoiceContext.Provider value={value}>
      <WebcamChoiceProvider value={choices}>{children}</WebcamChoiceProvider>
    </MediaChoiceContext.Provider>
  );
}

/** The listed input the saved choice names, else the first one, which is what a dialog would use. */
function inUse(
  inputs: readonly MediaInputChoice[],
  saved: MediaInputChoice | null,
): MediaInputChoice | null {
  return findMediaInput(inputs, saved) ?? inputs[0] ?? null;
}

function options(
  inputs: readonly MediaInputChoice[],
  unnamed: 'auth.pc.media.unnamedCamera' | 'auth.pc.media.unnamedMicrophone',
) {
  return inputs.map((input, index) => ({
    value: input.deviceId,
    // Before the first camera grant Windows gives no names.
    label: input.label === '' ? t(unnamed, { number: index + 1 }) : input.label,
  }));
}

/**
 * The live picture of the camera in use, the cameras and microphones to pick from when there is
 * more than one, and the microphone's level. Reports the picture's state like `CameraPreview`.
 */
export function CameraAndMicrophone({
  onState,
  testId = 'desktop.media',
}: {
  readonly onState?: ((state: WebcamState['kind']) => void) | undefined;
  readonly testId?: string;
}): React.JSX.Element {
  const { choices, choose } = useContext(MediaChoiceContext);
  const [preview, setPreview] = useState<WebcamState['kind']>('starting');
  // Read again once the picture is live: the names come with the first grant.
  const { cameras, microphones } = useMediaInputs(preview === 'live');
  const camera = inUse(cameras ?? [], choices.camera);
  const microphone = inUse(microphones ?? [], choices.microphone);

  return (
    // Side by side where there is room, so the check fits beside the picture instead of below it.
    <div className="@container" data-testid={testId}>
      <div className="grid items-start gap-4 @min-[44rem]:grid-cols-2">
        <CameraPreview
          labels={{
            retry: t('core.action.retry'),
            starting: t('core.camera.starting'),
            none: t('core.camera.none'),
            denied: t('core.camera.denied'),
            failed: t('core.camera.failed'),
          }}
          camera={camera}
          onState={(state) => {
            setPreview(state);
            onState?.(state);
          }}
          testId={`${testId}.preview`}
        />
        <div className="flex min-w-0 flex-col gap-4">
          {choose !== undefined && cameras !== null && cameras.length > 1 ? (
            <Group label={t('auth.pc.media.camera')}>
              <ChoiceList
                label={t('auth.pc.media.camera')}
                options={options(cameras, 'auth.pc.media.unnamedCamera')}
                value={camera?.deviceId ?? null}
                onChange={(deviceId) => {
                  const picked = cameras.find((input) => input.deviceId === deviceId);
                  if (picked !== undefined) choose('camera', picked);
                }}
                testId={`${testId}.cameras`}
              />
            </Group>
          ) : null}
          <Group label={t('auth.pc.media.microphone')}>
            <div className="flex flex-col gap-3">
              {choose !== undefined && microphones !== null && microphones.length > 1 ? (
                <ChoiceList
                  label={t('auth.pc.media.microphone')}
                  options={options(microphones, 'auth.pc.media.unnamedMicrophone')}
                  value={microphone?.deviceId ?? null}
                  onChange={(deviceId) => {
                    const picked = microphones.find((input) => input.deviceId === deviceId);
                    if (picked !== undefined) choose('microphone', picked);
                  }}
                  testId={`${testId}.microphones`}
                />
              ) : null}
              <MicrophoneMeter
                microphone={microphone}
                labels={{
                  level: t('auth.pc.media.level'),
                  hint: t('auth.pc.media.hint'),
                  none: t('auth.pc.media.micNone'),
                  denied: t('auth.pc.media.micDenied'),
                  failed: t('auth.pc.media.micFailed'),
                }}
                testId={`${testId}.microphone`}
              />
            </div>
          </Group>
        </div>
      </div>
    </div>
  );
}

/** Settings > Komputer ini: the same check in its own card. */
export function MediaSettings(): React.JSX.Element {
  return (
    <Card testId="desktop.settings.media">
      <Section title={t('auth.pc.media.title')}>
        <p className="-mt-2 text-small text-text-muted">{t('auth.pc.media.caption')}</p>
        <CameraAndMicrophone />
      </Section>
    </Card>
  );
}

function Group({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-small font-semibold text-text">{label}</p>
      {children}
    </div>
  );
}
