// The ownership video on the PC: a tile that records it while there is none, then a play and a
// record-again button with when it was taken. Used in the intake page, the servisan and the
// handover; the recording and the rules behind it are shared with the phone (`ownership-video.ts`).
import { formatDateTime } from '@bolusi/i18n';
import { Button, CaptureTile, Section } from '@bolusi/ui-web';
import { Play, Video } from 'lucide-react';

import type { ActionRunner, VideoMediaRef } from '../../screen-kit/index.js';
import { tn } from '../i18n.js';
import { useTicketVideo } from '../ownership-video.js';
import type { TicketDetailRow } from '../queries.js';
import { photoLabels } from './parts.js';

export function OwnershipVideoField({
  video,
  recordedAt,
  onRecord,
  onPlay,
  noCamera = false,
  invalid = false,
  testId,
}: {
  readonly video: VideoMediaRef | null;
  /** When the clip was taken, said beside it; null at intake, where it was just now. */
  readonly recordedAt: number | null;
  /** Absent ⇒ this person or computer cannot record one here. */
  readonly onRecord: (() => void) | undefined;
  readonly onPlay: ((video: VideoMediaRef) => void) | undefined;
  /** This person may take one, but this computer cannot. */
  readonly noCamera?: boolean;
  readonly invalid?: boolean;
  readonly testId: string;
}): React.JSX.Element {
  if (video === null) {
    if (onRecord === undefined && !noCamera) return <></>;
    return onRecord === undefined ? (
      <p className="text-body text-text-muted" data-testid={`${testId}.noCamera`}>
        {tn('repair.video.noCamera')}
      </p>
    ) : (
      <div className="w-[180px]">
        <CaptureTile
          label={tn('repair.video.label')}
          actionLabel={tn('repair.video.record')}
          icon={Video}
          state={null}
          labels={photoLabels()}
          onCapture={onRecord}
          invalid={invalid}
          testId={`${testId}.record`}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid={testId}>
      <p className="text-body font-medium text-text" data-testid={`${testId}.recorded`}>
        {recordedAt === null
          ? tn('repair.video.recorded')
          : tn('repair.video.recordedAt', { at: formatDateTime(recordedAt) })}
      </p>
      {onPlay === undefined ? null : (
        <Button
          label={tn('repair.video.play')}
          icon={Play}
          size="sm"
          onClick={() => onPlay(video)}
          data-testid={`${testId}.play`}
        />
      )}
      {onRecord === undefined ? null : (
        <Button
          label={tn('repair.video.retake')}
          icon={Video}
          size="sm"
          variant="text"
          onClick={onRecord}
          data-testid={`${testId}.retake`}
        />
      )}
    </div>
  );
}

/** The servisan's ownership video: shown once one is taken or a repair type asks for it. */
export function TicketVideoSection({
  ticket,
  canRecord,
  runner,
  onRecorded,
  testId,
}: {
  readonly ticket: TicketDetailRow;
  /** Intake permission and a servisan still open. */
  readonly canRecord: boolean;
  readonly runner: ActionRunner;
  readonly onRecorded: () => void;
  readonly testId: string;
}): React.JSX.Element | null {
  const clip = useTicketVideo({ ticket, canRecord, runner, onRecorded });
  if (!clip.shown) return null;
  return (
    <Section title={tn('repair.video.title')} testId={testId}>
      <div className="flex flex-col gap-3">
        {clip.latest === null ? (
          <p className="text-small font-semibold text-warning" data-testid={`${testId}.needed`}>
            {tn('repair.video.needed')}
          </p>
        ) : null}
        <OwnershipVideoField
          video={clip.video}
          recordedAt={clip.latest?.capturedAt ?? null}
          onRecord={clip.record}
          onPlay={clip.play}
          noCamera={clip.noCamera}
          testId={`${testId}.clip`}
        />
      </div>
    </Section>
  );
}

/** At handover, a repaired phone still without its video: taken here before it goes home. */
export function HandoverVideo({
  ticket,
  canRecord,
  runner,
  testId,
}: {
  readonly ticket: TicketDetailRow;
  readonly canRecord: boolean;
  readonly runner: ActionRunner;
  readonly testId: string;
}): React.JSX.Element {
  // The servisan reads live, so the clip taken here shows (and unblocks) without a reload.
  const clip = useTicketVideo({ ticket, canRecord, runner, onRecorded: () => undefined });
  return (
    <section className="mt-4 flex flex-col gap-2" data-testid={testId}>
      <h3 className="text-body font-semibold text-text">{tn('repair.video.title')}</h3>
      {/* The footer already says it is needed: say what to film. */}
      <p className="text-small text-text-muted">{tn('repair.video.hint')}</p>
      <OwnershipVideoField
        video={clip.video}
        recordedAt={clip.latest?.capturedAt ?? null}
        onRecord={clip.record}
        onPlay={clip.play}
        noCamera={clip.noCamera}
        testId={`${testId}.clip`}
      />
    </section>
  );
}
