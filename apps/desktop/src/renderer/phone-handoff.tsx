// Taking a photo or signature on a store phone instead of this PC: a QR the phone scans with its
// camera, then a wait until the phone sends. The phone and PC must be on the same Wi-Fi; nothing
// goes through the internet. What the phone sends comes back like the webcam's or the pad's.
import { t } from '@bolusi/i18n';
import { Banner, Button, Dialog, QrCode, Spinner, type DrawnSignature } from '@bolusi/ui-web';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { HandoffBridge, HandoffKind, HandoffPageLabels } from '../main/bridge.js';

/** The desktop app's phone handoff, when the page runs inside it. */
export function handoffBridge(): HandoffBridge | undefined {
  return (window as { bolusi?: { handoff?: HandoffBridge } }).bolusi?.handoff;
}

type HandoffState =
  | { readonly kind: 'opening' }
  | {
      readonly kind: 'waiting';
      readonly id: string;
      readonly urls: readonly string[];
      readonly opened: boolean;
    }
  | { readonly kind: 'problem'; readonly problem: 'noNetwork' | 'failed' | 'expired' };

export type HandoffResult =
  | { readonly kind: 'photo'; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'signature'; readonly signature: DrawnSignature };

function pageLabels(kind: HandoffKind, title: string): HandoffPageLabels {
  return {
    title,
    hint: t(kind === 'photo' ? 'core.handoff.page.photoHint' : 'core.signature.hint'),
    take: t('core.camera.shoot'),
    retake: t('core.camera.retake'),
    clear: t('core.signature.clear'),
    send: t('core.handoff.page.send'),
    sending: t('core.handoff.page.sending'),
    sent: t('core.handoff.page.sent'),
    failed: t('core.handoff.page.failed'),
    expired: t('core.handoff.page.expired'),
    unreadable: t('core.handoff.page.unreadable'),
  };
}

export function PhoneHandoffDialog({
  handoff,
  open,
  kind,
  title,
  onDone,
  onBack,
  onClose,
}: {
  readonly handoff: HandoffBridge;
  readonly open: boolean;
  readonly kind: HandoffKind;
  readonly title: string;
  readonly onDone: (result: HandoffResult) => void;
  /** Back to the webcam or the on-screen pad. */
  readonly onBack: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [state, setState] = useState<HandoffState>({ kind: 'opening' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    let id: string | null = null;
    setState({ kind: 'opening' });
    const stop = handoff.onEvent((event) => {
      if (!live || event.id !== id) return;
      if (event.type === 'opened') {
        setState((current) =>
          current.kind === 'waiting' ? { ...current, opened: true } : current,
        );
      } else if (event.type === 'expired') {
        id = null;
        setState({ kind: 'problem', problem: 'expired' });
      } else if (event.type === 'photo') {
        id = null;
        onDone({ kind: 'photo', bytes: new Uint8Array(event.bytes) });
      } else if (event.type === 'signature') {
        id = null;
        onDone({
          kind: 'signature',
          signature: {
            strokes: event.strokes.map((stroke) => stroke.map(({ x, y }) => ({ x, y }))),
            pad: event.pad,
          },
        });
      }
    });
    handoff.open(kind, pageLabels(kind, title)).then(
      (opened) => {
        if (!live) {
          if (opened.ok) void handoff.cancel(opened.id);
          return;
        }
        if (opened.ok) {
          id = opened.id;
          setState({ kind: 'waiting', id: opened.id, urls: opened.urls, opened: false });
        } else {
          setState({ kind: 'problem', problem: opened.problem });
        }
      },
      () => {
        if (live) setState({ kind: 'problem', problem: 'failed' });
      },
    );
    return () => {
      live = false;
      stop();
      if (id !== null) void handoff.cancel(id);
      // Opened again later, it must not flash this code, which no longer works.
      setState({ kind: 'opening' });
    };
    // A new title or kind is a new capture; onDone is the host's, made once.
  }, [open, kind, title, attempt, handoff]);

  const url = state.kind === 'waiting' ? state.urls[0] : undefined;
  return (
    <Dialog
      open={open}
      onRequestClose={onClose}
      title={title}
      description={t('core.handoff.scanHint')}
      closeLabel={t('core.action.close')}
      testId="desktop.handoff"
      footer={
        <Button
          label={t(kind === 'photo' ? 'core.handoff.useWebcam' : 'core.handoff.useScreen')}
          variant="text"
          onClick={onBack}
          className="mr-auto"
          data-testid="desktop.handoff.back"
        />
      }
    >
      <div className="flex min-h-[280px] flex-col items-center justify-center gap-4 text-center">
        {state.kind === 'opening' ? <Spinner size={24} /> : null}
        {state.kind === 'waiting' && url !== undefined ? (
          <>
            <QrCode value={url} label={t('core.handoff.qrLabel')} testId="desktop.handoff.qr" />
            <p className="text-small text-text-muted">
              {t('core.handoff.orOpen')}{' '}
              <span className="select-all font-mono text-text" data-testid="desktop.handoff.url">
                {url}
              </span>
            </p>
            <p
              role="status"
              className="flex items-center gap-2 text-body text-text"
              data-testid="desktop.handoff.status"
            >
              <Spinner />
              {t(state.opened ? 'core.handoff.opened' : 'core.handoff.waiting')}
            </p>
          </>
        ) : null}
        {state.kind === 'problem' ? (
          <div
            className="flex w-full flex-col items-center gap-4"
            data-testid="desktop.handoff.problem"
          >
            <Banner tone="danger" message={t(`core.handoff.${state.problem}`)} className="w-full" />
            <Button
              label={t('core.action.retry')}
              icon={RefreshCw}
              onClick={() => setAttempt((n) => n + 1)}
              data-testid="desktop.handoff.retry"
            />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
