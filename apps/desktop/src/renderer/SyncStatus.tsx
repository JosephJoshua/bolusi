// Whether this PC's work has reached the server: a quiet line in the title bar, and a panel with the detail and "Kirim sekarang". The phone's sync status rules decide every word
// (shared model); only the layout is the PC's.
import {
  formatRelative,
  t,
  translateErrorCode,
  translateOpType,
  translateRejection,
} from '@bolusi/i18n';
import {
  firstSyncPercent,
  manualSync,
  manualSyncErrorShown,
  mediaQueue,
  reassuranceMessage,
  relativeLabel,
  SYNC_TITLE_KEY,
  syncProblems,
  syncTitleState,
  type SyncStatusInput,
  type SyncTitleState,
} from '@bolusi/device/models/sync-status/model';
import { Banner, Button, Dialog, Fact, FactGrid, Tooltip } from '@bolusi/ui-web';
import { clsx } from 'clsx';
import {
  CircleAlert,
  CircleCheck,
  CloudOff,
  CloudUpload,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { useTick } from '@bolusi/modules/screen-kit';
import { useMemo, useState } from 'react';

import { BAR_CONTROL } from './TitleBar.js';

// Keyed by what the line says, so photos still waiting never show the all-sent tick.
const ICON: Readonly<Record<SyncTitleState, LucideIcon>> = {
  synced: CircleCheck,
  pending: CloudUpload,
  photosPending: CloudUpload,
  syncing: RefreshCw,
  offline: CloudOff,
  attention: CircleAlert,
};

// On the dark title bar: only "all sent" and "check this" take a colour; the rest stay quiet.
const TONE: Readonly<Record<SyncTitleState, string | undefined>> = {
  synced: 'text-chrome-success',
  pending: undefined,
  photosPending: undefined,
  syncing: undefined,
  offline: undefined,
  attention: 'text-chrome-warning',
};

/** How many refused changes the panel lists; the rest wait behind "Tampilkan lainnya". */
const REJECTED_SHOWN = 20;

/** How often "Terakhir terhubung …" and the staleness are read again without a new snapshot. */
export const SYNC_AGE_REFRESH_MS = 30_000;

/**
 * The snapshot with its `now` moved on by the time since it arrived. A server that hangs sends no
 * new snapshot, and "baru saja" must still turn into "5 menit lalu". The core's clock stays the
 * reference; only the time passed is read here.
 */
function useAgedInput(input: SyncStatusInput): SyncStatusInput {
  useTick(SYNC_AGE_REFRESH_MS);
  const arrivedAt = useMemo(() => ({ input, at: Date.now() }), [input]);
  return { ...input, now: input.now + Math.max(0, Date.now() - arrivedAt.at) };
}

export function SyncStatusButton({
  input: snapshot,
  open,
  onOpenChange: setOpen,
  onSyncNow,
  onReenrol,
  onMarkRejectedHandled,
}: {
  readonly input: SyncStatusInput;
  /** The panel; the app holds it, since a refused change on a servisan opens it too. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSyncNow: () => void;
  /** Opens registration again, for when the server no longer knows this PC. */
  readonly onReenrol: () => void;
  /** The person has dealt with the refused changes listed; they stop asking for attention. */
  readonly onMarkRejectedHandled: (opIds: readonly string[]) => void;
}): React.JSX.Element {
  const input = useAgedInput(snapshot);
  const state = syncTitleState(input);
  const Icon = ICON[state];
  const title = t(SYNC_TITLE_KEY[state]);
  return (
    <>
      {/* A narrow window keeps the icon, named by its tooltip; a wide one says it in words too. */}
      <Tooltip label={title} side="bottom">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={title}
          data-testid="desktop.sync"
          data-state={state}
          className={BAR_CONTROL}
        >
          <Icon
            size={16}
            aria-hidden
            className={clsx('shrink-0', TONE[state], state === 'syncing' && 'animate-spin')}
          />
          <span className="hidden whitespace-nowrap @min-[56rem]:inline">{title}</span>
        </button>
      </Tooltip>
      <SyncStatusDialog
        open={open}
        input={input}
        onClose={() => setOpen(false)}
        onSyncNow={onSyncNow}
        onMarkRejectedHandled={onMarkRejectedHandled}
        onReenrol={() => {
          setOpen(false);
          onReenrol();
        }}
      />
    </>
  );
}

function SyncStatusDialog({
  open,
  input,
  onClose,
  onSyncNow,
  onReenrol,
  onMarkRejectedHandled,
}: {
  readonly open: boolean;
  readonly input: SyncStatusInput;
  readonly onClose: () => void;
  readonly onSyncNow: () => void;
  readonly onReenrol: () => void;
  readonly onMarkRejectedHandled: (opIds: readonly string[]) => void;
}): React.JSX.Element {
  const [rejectedShown, setRejectedShown] = useState(REJECTED_SHOWN);
  const manual = manualSync(input);
  const manualError = manualSyncErrorShown(input);
  const waitingPhotos = mediaQueue(input).length;
  const failedPhotos = input.media.filter((row) => row.uploadStatus === 'failed').length;
  return (
    <Dialog
      open={open}
      onRequestClose={onClose}
      title={t(SYNC_TITLE_KEY[syncTitleState(input)])}
      description={reassuranceMessage(input, 'computer')}
      closeLabel={t('core.action.close')}
      size="md"
      testId="desktop.sync.dialog"
      footer={
        // Sending cannot help a PC the server forgot: registering it again is the one way on.
        manual.kind === 'reenroll' ? (
          <Button
            label={t('auth.pc.unrecognised.action')}
            variant="primary"
            onClick={onReenrol}
            data-testid="desktop.sync.reenrol"
          />
        ) : (
          <Button
            label={t('sync.action.syncNow')}
            variant="primary"
            icon={RefreshCw}
            busy={
              manual.kind === 'busy' ||
              input.loopState === 'pushing' ||
              input.loopState === 'pulling'
            }
            disabled={manual.kind === 'disabled'}
            onClick={onSyncNow}
            data-testid="desktop.sync.now"
          />
        )
      }
    >
      <div className="flex flex-col gap-6">
        <FactGrid>
          <Fact
            label={t('sync.status.changesLabel')}
            value={t('sync.status.waitingCount', { count: input.pendingOperationCount })}
          />
          <Fact
            label={t('sync.status.photosLabel')}
            value={t('sync.status.waitingCount', { count: waitingPhotos })}
          />
        </FactGrid>
        <p className="text-small text-text-muted">
          {t('sync.status.lastSynced', { relative: relativeLabel(input) })}
        </p>
        {/* The answer to "Kirim sekarang" when it did not get through; the loop keeps retrying. */}
        {manualError === null ? null : (
          <div data-testid="desktop.sync.manualError">
            <Banner tone="warning" message={translateErrorCode(manualError)} />
          </div>
        )}
        {input.firstSync === null ? null : (
          <Banner
            tone="info"
            message={t('sync.firstSync.banner', { percent: firstSyncPercent(input.firstSync) })}
          />
        )}
        {syncProblems(input).some((problem) => problem.kind === 'deviceUnrecognised') ? (
          <Banner tone="warning" message={t('auth.pc.unrecognised.body')} />
        ) : null}
        {failedPhotos === 0 ? null : (
          <Banner tone="warning" message={t('sync.pc.mediaFailed', { count: failedPhotos })} />
        )}
        {syncProblems(input).some((problem) => problem.kind === 'appUpdateNeeded') ? (
          <Banner tone="warning" message={t('sync.updateNeeded.body')} />
        ) : null}
        {input.quarantined.length === 0 ? null : (
          <Banner tone="warning" message={t('sync.quarantine.body')} />
        )}
        {input.rejected.length === 0 ? null : (
          <section className="flex flex-col gap-2" data-testid="desktop.sync.rejected">
            <h3 className="text-heading font-semibold text-text">
              {t('sync.rejected.title', { count: input.rejected.length })}
            </h3>
            <p className="text-small text-text-muted">{t('sync.pc.rejectedExplain')}</p>
            <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
              {input.rejected.slice(0, rejectedShown).map((row) => (
                <li key={row.opId} className="flex flex-col gap-1 px-3 py-2">
                  <span className="text-body text-text">
                    {translateRejection(row.rejectionCode, row.rejectionReason)}
                  </span>
                  <span className="text-small text-text-muted">
                    {row.subject === null
                      ? t('sync.rejected.opMeta', {
                          opType: translateOpType(row.type),
                          time: formatRelative(input.now - row.at),
                        })
                      : t('sync.rejected.opMetaSubject', {
                          opType: translateOpType(row.type),
                          subject: row.subject,
                          time: formatRelative(input.now - row.at),
                        })}
                  </span>
                </li>
              ))}
            </ul>
            {input.rejected.length > rejectedShown ? (
              <Button
                label={t('sync.rejected.more', {
                  count: Math.min(input.rejected.length - rejectedShown, REJECTED_SHOWN),
                })}
                variant="text"
                className="self-start"
                onClick={() => setRejectedShown((shown) => shown + REJECTED_SHOWN)}
              />
            ) : null}
            <Button
              label={t('sync.rejected.handled')}
              variant="secondary"
              className="self-start"
              onClick={() => onMarkRejectedHandled(input.rejected.map((row) => row.opId))}
              data-testid="desktop.sync.rejected.handled"
            />
          </section>
        )}
      </div>
    </Dialog>
  );
}
