// Taking photos and signatures on a store phone instead of this PC. The first time, the counter
// shows a QR the phone scans with its camera; after that the phone stays paired, and every photo
// or signature the counter asks for appears on it by itself until the pairing ends. The phone and
// PC must be on the same Wi-Fi; nothing goes through the internet.
import { t } from '@bolusi/i18n';
import { Banner, Button, Dialog, QrCode, Spinner, type DrawnSignature } from '@bolusi/ui-web';
import { RefreshCw, Smartphone } from 'lucide-react';

import type {
  HandoffBridge,
  HandoffEvent,
  HandoffKind,
  HandoffPageLabels,
} from '../main/bridge.js';

/** The desktop app's phone handoff, when the page runs inside it. */
export function handoffBridge(): HandoffBridge | undefined {
  return (window as { bolusi?: { handoff?: HandoffBridge } }).bolusi?.handoff;
}

export type PhoneLink =
  | { readonly state: 'none' | 'opening' }
  | { readonly state: 'problem'; readonly problem: 'noNetwork' | 'failed' | 'expired' }
  | {
      readonly state: 'ready';
      readonly id: string;
      readonly urls: readonly string[];
      /** The phone has opened the page. */
      readonly paired: boolean;
    };

export type HandoffResult =
  | { readonly kind: 'photo'; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'signature'; readonly signature: DrawnSignature };

export function pageLabels(): HandoffPageLabels {
  return {
    photoHint: t('core.handoff.page.photoHint'),
    signatureHint: t('core.signature.hint'),
    take: t('core.camera.shoot'),
    retake: t('core.camera.retake'),
    clear: t('core.signature.clear'),
    send: t('core.handoff.page.send'),
    sending: t('core.handoff.page.sending'),
    sent: t('core.handoff.page.sent'),
    waiting: t('core.handoff.page.waiting'),
    rotate: t('core.handoff.page.rotate'),
    rotateNow: t('core.handoff.page.rotateNow'),
    failed: t('core.handoff.page.failed'),
    withdrawn: t('core.handoff.page.withdrawn'),
    expired: t('core.handoff.page.expired'),
    unreadable: t('core.handoff.page.unreadable'),
  };
}

/**
 * The pairing with a phone, kept for as long as the counter app is open: one QR for every photo
 * and signature after it. `take` asks the paired phone for one step and resolves with what it
 * sends, or null when the step is withdrawn.
 */
export class PhoneLinkStore {
  private link: PhoneLink = { state: 'none' };
  private step: {
    readonly kind: HandoffKind;
    readonly title: string;
    seq: number | null;
    readonly resolve: (result: HandoffResult | null) => void;
  } | null = null;
  private readonly listeners = new Set<() => void>();
  private stopEvents: (() => void) | null = null;

  constructor(private readonly handoff: HandoffBridge) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.stopEvents ??= this.handoff.onEvent((event) => this.onEvent(event));
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): PhoneLink => this.link;

  get paired(): boolean {
    return this.link.state === 'ready' && this.link.paired;
  }

  /** Asks the phone for one photo or signature, pairing first when there is no phone yet. */
  take(kind: HandoffKind, title: string): Promise<HandoffResult | null> {
    this.withdraw();
    return new Promise((resolve) => {
      this.step = { kind, title, seq: null, resolve };
      void this.ensureLink().then(() => this.askPhone());
    });
  }

  /** The counter backed out of the current step; the pairing stays for the next one. */
  withdraw(): void {
    const step = this.step;
    if (step === null) return;
    this.step = null;
    if (this.link.state === 'ready' && step.seq !== null) {
      void this.handoff.withdraw(this.link.id, step.seq);
    }
    step.resolve(null);
  }

  /** A fresh QR, for another phone or after a failure; the current step moves to it. */
  repair(): void {
    if (this.link.state === 'ready') void this.handoff.unpair(this.link.id);
    this.set({ state: 'none' });
    if (this.step !== null) this.step.seq = null;
    void this.ensureLink().then(() => this.askPhone());
  }

  /** Ends the pairing; the counter app is closing. */
  close(): void {
    this.withdraw();
    if (this.link.state === 'ready') void this.handoff.unpair(this.link.id);
    this.set({ state: 'none' });
    this.stopEvents?.();
    this.stopEvents = null;
  }

  private set(link: PhoneLink): void {
    this.link = link;
    for (const listener of this.listeners) listener();
  }

  private async ensureLink(): Promise<void> {
    if (this.link.state === 'ready' || this.link.state === 'opening') return;
    this.set({ state: 'opening' });
    try {
      const opened = await this.handoff.pair(pageLabels());
      this.set(
        opened.ok
          ? { state: 'ready', id: opened.id, urls: opened.urls, paired: false }
          : { state: 'problem', problem: opened.problem },
      );
    } catch {
      this.set({ state: 'problem', problem: 'failed' });
    }
  }

  private async askPhone(): Promise<void> {
    const step = this.step;
    const link = this.link;
    if (step === null || step.seq !== null || link.state !== 'ready') return;
    const seq = await this.handoff.ask(link.id, step.kind, step.title);
    if (this.step !== step) {
      if (seq !== null) void this.handoff.withdraw(link.id, seq);
      return;
    }
    if (seq === null) {
      // The pairing ended under us: start a new one.
      this.repair();
      return;
    }
    step.seq = seq;
  }

  private onEvent(event: HandoffEvent): void {
    const link = this.link;
    if (link.state !== 'ready' || event.id !== link.id) return;
    if (event.type !== 'photo' && event.type !== 'signature') {
      if (event.type === 'paired') {
        this.set({ ...link, paired: true });
        return;
      }
      // Expired: a step still open waits on a new code.
      this.set(this.step === null ? { state: 'none' } : { state: 'problem', problem: 'expired' });
      if (this.step !== null) this.step.seq = null;
      return;
    }
    const step = this.step;
    if (step === null || step.seq !== event.seq || step.kind !== event.type) return;
    this.step = null;
    step.resolve(
      event.type === 'photo'
        ? { kind: 'photo', bytes: new Uint8Array(event.bytes) }
        : {
            kind: 'signature',
            signature: {
              strokes: event.strokes.map((stroke) => stroke.map(({ x, y }) => ({ x, y }))),
              pad: event.pad,
            },
          },
    );
  }
}

export function PhoneHandoffDialog({
  open,
  link,
  kind,
  title,
  backLabel,
  onBack,
  onNewCode,
  onClose,
}: {
  readonly open: boolean;
  readonly link: PhoneLink;
  readonly kind: HandoffKind;
  readonly title: string;
  /** Back to the webcam or the on-screen pad, when this PC has one. */
  readonly backLabel: string | null;
  readonly onBack: () => void;
  readonly onNewCode: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const url = link.state === 'ready' ? link.urls[0] : undefined;
  const paired = link.state === 'ready' && link.paired;
  return (
    <Dialog
      open={open}
      onRequestClose={onClose}
      title={title}
      description={paired ? undefined : t('core.handoff.scanHint')}
      closeLabel={t('core.action.close')}
      testId="desktop.handoff"
      footer={
        <>
          {backLabel === null ? null : (
            <Button
              label={backLabel}
              variant="text"
              onClick={onBack}
              data-testid="desktop.handoff.back"
            />
          )}
          {paired ? (
            <Button
              label={t('core.handoff.newCode')}
              variant="text"
              onClick={onNewCode}
              className="ml-auto"
              data-testid="desktop.handoff.newCode"
            />
          ) : null}
        </>
      }
    >
      <div className="flex min-h-[280px] flex-col items-center justify-center gap-4 text-center">
        {link.state === 'opening' || link.state === 'none' ? <Spinner size={24} /> : null}
        {paired ? (
          <div className="flex flex-col items-center gap-3" data-testid="desktop.handoff.onPhone">
            <Smartphone size={40} aria-hidden className="text-primary" />
            <p className="text-heading font-semibold text-text">
              {t(kind === 'photo' ? 'core.handoff.photoOnPhone' : 'core.handoff.signOnPhone')}
            </p>
            <p
              role="status"
              className="flex items-center gap-2 text-body text-text-muted"
              data-testid="desktop.handoff.status"
            >
              <Spinner />
              {t('core.handoff.waitingSend')}
            </p>
          </div>
        ) : null}
        {!paired && url !== undefined ? (
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
              {t('core.handoff.waiting')}
            </p>
          </>
        ) : null}
        {link.state === 'problem' ? (
          <div
            className="flex w-full flex-col items-center gap-4"
            data-testid="desktop.handoff.problem"
          >
            <Banner tone="danger" message={t(`core.handoff.${link.problem}`)} className="w-full" />
            <Button
              label={t('core.action.retry')}
              icon={RefreshCw}
              onClick={onNewCode}
              data-testid="desktop.handoff.retry"
            />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
