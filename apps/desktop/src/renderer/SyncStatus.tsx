// Whether this PC's work has reached the server: a quiet line at the foot of the sidebar, and a
// panel with the detail and "Kirim sekarang". The phone's sync status rules decide every word
// (shared model); only the layout is the PC's.
import { formatRelative, t, translateOpType, translateRejection } from '@bolusi/i18n';
import {
  firstSyncPercent,
  manualSync,
  mediaQueue,
  reassuranceMessage,
  relativeLabel,
  SYNC_TITLE_KEY,
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
import { useState } from 'react';

// Keyed by what the line says, so photos still waiting never show the all-sent tick.
const ICON: Readonly<Record<SyncTitleState, LucideIcon>> = {
  synced: CircleCheck,
  pending: CloudUpload,
  photosPending: CloudUpload,
  syncing: RefreshCw,
  offline: CloudOff,
  attention: CircleAlert,
};

const TONE: Readonly<Record<SyncTitleState, string>> = {
  synced: 'text-success',
  pending: 'text-text-muted',
  photosPending: 'text-text-muted',
  syncing: 'text-text-muted',
  offline: 'text-text-muted',
  attention: 'text-warning',
};

/** How many refused changes the panel lists; the rest wait behind "Tampilkan lainnya". */
const REJECTED_SHOWN = 20;

export function SyncStatusButton({
  input,
  compact,
  onSyncNow,
}: {
  readonly input: SyncStatusInput;
  /** The collapsed sidebar: the icon only, named by its tooltip. */
  readonly compact: boolean;
  readonly onSyncNow: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const state = syncTitleState(input);
  const Icon = ICON[state];
  const title = t(SYNC_TITLE_KEY[state]);
  const button = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={title}
      data-testid="desktop.sync"
      data-state={state}
      className={clsx(
        'flex w-full cursor-pointer items-center gap-2 rounded-sm text-left text-small hover:bg-black/5',
        compact ? 'justify-center p-2' : 'px-2 py-1.5',
      )}
    >
      <Icon
        size={16}
        aria-hidden
        className={clsx('shrink-0', TONE[state], state === 'syncing' && 'animate-spin')}
      />
      {compact ? null : <span className="min-w-0 flex-1 break-words text-text-muted">{title}</span>}
    </button>
  );
  return (
    <>
      {compact ? (
        <Tooltip label={title} side="right">
          {button}
        </Tooltip>
      ) : (
        button
      )}
      <SyncStatusDialog
        open={open}
        input={input}
        onClose={() => setOpen(false)}
        onSyncNow={onSyncNow}
      />
    </>
  );
}

function SyncStatusDialog({
  open,
  input,
  onClose,
  onSyncNow,
}: {
  readonly open: boolean;
  readonly input: SyncStatusInput;
  readonly onClose: () => void;
  readonly onSyncNow: () => void;
}): React.JSX.Element {
  const [rejectedShown, setRejectedShown] = useState(REJECTED_SHOWN);
  const manual = manualSync(input);
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
        <Button
          label={t('sync.action.syncNow')}
          variant="primary"
          icon={RefreshCw}
          busy={
            manual.kind === 'busy' || input.loopState === 'pushing' || input.loopState === 'pulling'
          }
          disabled={manual.kind === 'disabled'}
          onClick={onSyncNow}
          data-testid="desktop.sync.now"
        />
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
        {input.firstSync === null ? null : (
          <Banner
            tone="info"
            message={t('sync.firstSync.banner', { percent: firstSyncPercent(input.firstSync) })}
          />
        )}
        {failedPhotos === 0 ? null : (
          <Banner tone="warning" message={t('sync.media.failedBody', { count: failedPhotos })} />
        )}
        {input.quarantined.length === 0 ? null : (
          <Banner tone="warning" message={t('sync.quarantine.body')} />
        )}
        {input.rejected.length === 0 ? null : (
          <section className="flex flex-col gap-2" data-testid="desktop.sync.rejected">
            <h3 className="text-heading font-semibold text-text">
              {t('sync.rejected.title', { count: input.rejected.length })}
            </h3>
            <p className="text-small text-text-muted">{t('sync.rejected.explain')}</p>
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
          </section>
        )}
      </div>
    </Dialog>
  );
}
