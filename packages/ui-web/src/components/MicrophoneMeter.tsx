// A microphone check: a bar that moves with the room's sound, or why the microphone cannot listen.
import { Mic, MicOff } from 'lucide-react';

import { useMicrophoneLevel } from './media-inputs.js';
import type { MediaInputChoice } from './webcam.js';

export interface MicrophoneMeterLabels {
  /** Read aloud for the bar, e.g. "Suara mikrofon". */
  readonly level: string;
  /** Under the bar while it listens, e.g. "Coba bicara; garisnya ikut bergerak." */
  readonly hint: string;
  readonly none: string;
  readonly denied: string;
  readonly failed: string;
}

export function MicrophoneMeter({
  microphone,
  labels,
  testId = 'microphone',
}: {
  readonly microphone: MediaInputChoice | null;
  readonly labels: MicrophoneMeterLabels;
  readonly testId?: string;
}): React.JSX.Element {
  const level = useMicrophoneLevel(microphone);
  if (level.kind === 'none' || level.kind === 'denied' || level.kind === 'failed') {
    return (
      <p
        className="flex items-center gap-2 text-small text-text"
        data-testid={testId}
        data-state={level.kind}
      >
        <MicOff size={16} aria-hidden className="shrink-0 text-warning" />
        {labels[level.kind]}
      </p>
    );
  }
  const value = level.kind === 'live' ? level.level : 0;
  return (
    <div className="flex flex-col gap-1" data-testid={testId} data-state={level.kind}>
      <div className="flex items-center gap-2">
        <Mic size={16} aria-hidden className="shrink-0 text-text-muted" />
        <div
          role="meter"
          aria-label={labels.level}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(value * 100)}
          className="h-2 flex-1 overflow-hidden rounded-full bg-surface-alt"
        >
          <div
            className="h-full origin-left rounded-full bg-success transition-transform duration-75"
            style={{ transform: `scaleX(${value})` }}
          />
        </div>
      </div>
      <p className="text-small text-text-muted">{labels.hint}</p>
    </div>
  );
}
