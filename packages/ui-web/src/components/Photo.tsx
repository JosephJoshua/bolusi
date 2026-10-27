// Photos as small tiles that open a full-window viewer: arrows or the keyboard move between them,
// a click zooms in where you clicked and moving the mouse pans, and the photo can be saved.
import * as RadixDialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  ShieldAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type MouseEvent } from 'react';

import { OverflowText } from './OverflowText.js';
import { Skeleton } from './States.js';
import { Tooltip } from './Tooltip.js';

/** A photo's load state, the same four states the phone shows. */
export type PhotoState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly uri: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'mismatch' };

export interface PhotoLabels {
  /** "Foto belum tersedia" */
  readonly unavailable: string;
  /** "Foto tidak cocok" */
  readonly mismatch: string;
}

function PhotoFace({
  state,
  labels,
  alt,
}: {
  readonly state: PhotoState;
  readonly labels: PhotoLabels;
  readonly alt: string;
}): React.JSX.Element {
  switch (state.kind) {
    case 'loading':
      return <Skeleton className="size-full rounded-none" />;
    case 'ready':
      return <img src={state.uri} alt={alt} draggable={false} className="size-full object-cover" />;
    case 'unavailable':
    case 'mismatch': {
      const Icon: LucideIcon = state.kind === 'mismatch' ? ShieldAlert : ImageOff;
      return (
        <span
          className={clsx(
            'flex size-full flex-col items-center justify-center gap-1 p-2 text-center text-small',
            state.kind === 'mismatch'
              ? 'bg-danger-bg text-on-danger-bg'
              : 'bg-surface-alt text-text-muted',
          )}
        >
          <Icon size={20} aria-hidden />
          {state.kind === 'mismatch' ? labels.mismatch : labels.unavailable}
        </span>
      );
    }
  }
}

/** One photo with its caption; pressing it opens the viewer. */
export function PhotoTile({
  state,
  caption,
  labels,
  openLabel,
  onOpen,
  size = 'md',
  testId,
}: {
  readonly state: PhotoState;
  readonly caption: string;
  readonly labels: PhotoLabels;
  readonly openLabel: string;
  readonly onOpen: () => void;
  readonly size?: 'sm' | 'md';
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <figure className={clsx('flex shrink-0 flex-col gap-1', size === 'sm' ? 'w-20' : 'w-28')}>
      <button
        type="button"
        aria-label={`${openLabel}: ${caption}`}
        onClick={onOpen}
        data-testid={testId}
        className="aspect-[3/4] w-full cursor-zoom-in overflow-hidden rounded-sm border border-border bg-surface-alt transition-[filter] hover:brightness-95"
      >
        <PhotoFace state={state} labels={labels} alt={caption} />
      </button>
      <figcaption>
        <OverflowText text={caption} className="text-small text-text-muted" />
      </figcaption>
    </figure>
  );
}

/** An empty place for a photo still to take, or a taken one to retake. */
export function CaptureTile({
  label,
  actionLabel,
  state,
  labels,
  onCapture,
  icon: Icon = Camera,
  invalid = false,
  testId,
}: {
  readonly label: string;
  readonly actionLabel: string;
  /** What capturing means: a camera by default, a pen for a signature. */
  readonly icon?: LucideIcon;
  /** The photo taken, if any. */
  readonly state: PhotoState | null;
  readonly labels: PhotoLabels;
  readonly onCapture: () => void;
  readonly invalid?: boolean;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onCapture}
      data-testid={testId}
      aria-label={`${actionLabel}: ${label}`}
      className={clsx(
        'group flex w-full cursor-pointer flex-col overflow-hidden rounded-sm border text-left transition-colors',
        state === null
          ? clsx(
              'border-dashed bg-surface hover:bg-surface-alt',
              invalid ? 'border-danger' : 'border-border',
            )
          : 'border-border bg-surface',
      )}
    >
      <span className="relative block aspect-[4/3] w-full overflow-hidden">
        {state === null ? (
          <span className="flex size-full flex-col items-center justify-center gap-1 text-primary">
            <Icon size={22} aria-hidden />
            <span className="text-small font-semibold">{actionLabel}</span>
          </span>
        ) : (
          <>
            <PhotoFace state={state} labels={labels} alt={label} />
            <span className="absolute inset-x-0 bottom-0 flex h-8 items-center justify-center gap-1 bg-black/55 text-small font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <Icon size={14} aria-hidden />
              {actionLabel}
            </span>
          </>
        )}
      </span>
      <span className="border-t border-border px-2 py-1 text-small font-medium text-text">
        {label}
      </span>
    </button>
  );
}

export interface ViewerPhoto {
  readonly key: string;
  readonly caption: string;
  /** The group it belongs to, such as "Foto saat diterima". */
  readonly group: string;
  readonly state: PhotoState;
}

export interface PhotoViewerLabels extends PhotoLabels {
  readonly close: string;
  readonly previous: string;
  readonly next: string;
  readonly download: string;
  /** "{index} dari {total}" already filled in by the caller for each position. */
  readonly position: (index: number, total: number) => string;
}

export function PhotoViewer({
  photos,
  index,
  onIndexChange,
  onClose,
  onDownload,
  notice = null,
  labels,
}: {
  readonly photos: readonly ViewerPhoto[];
  /** The open photo, or null when the viewer is closed. */
  readonly index: number | null;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
  readonly onDownload?: ((photo: ViewerPhoto) => void) | undefined;
  /** A short message about the open photo, such as a save that failed. */
  readonly notice?: string | null | undefined;
  readonly labels: PhotoViewerLabels;
}): React.JSX.Element {
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  const photo = index === null ? undefined : photos[index];
  useEffect(() => setZoom(null), [index]);

  const go = (step: number): void => {
    if (index === null || photos.length === 0) return;
    onIndexChange((index + step + photos.length) % photos.length);
  };
  const origin = (event: MouseEvent<HTMLElement>): { x: number; y: number } => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * 100,
      y: ((event.clientY - box.top) / box.height) * 100,
    };
  };

  return (
    <RadixDialog.Root
      open={photo !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-neutral-950 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <RadixDialog.Content
          aria-describedby={undefined}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') go(-1);
            if (event.key === 'ArrowRight') go(1);
          }}
          className="fixed inset-0 z-50 flex flex-col text-white focus:outline-none data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out"
          data-testid="photoViewer"
        >
          {photo === undefined || index === null ? null : (
            <>
              <div className="flex h-14 shrink-0 items-center gap-4 px-4">
                <div className="min-w-0 flex-1">
                  <RadixDialog.Title className="truncate text-body font-semibold">
                    {photo.caption}
                  </RadixDialog.Title>
                  <p className="text-small text-white/70">
                    {photo.group} · {labels.position(index + 1, photos.length)}
                  </p>
                </div>
                {notice === null ? null : (
                  <p role="status" className="text-small font-semibold text-warning-bg">
                    {notice}
                  </p>
                )}
                {onDownload === undefined || photo.state.kind !== 'ready' ? null : (
                  <button
                    type="button"
                    onClick={() => onDownload(photo)}
                    className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-sm px-3 text-body font-semibold hover:bg-white/15"
                  >
                    <Download size={18} aria-hidden />
                    {labels.download}
                  </button>
                )}
                <RadixDialog.Close
                  aria-label={labels.close}
                  className="flex size-9 cursor-pointer items-center justify-center rounded-sm hover:bg-white/15"
                >
                  <X size={20} aria-hidden />
                </RadixDialog.Close>
              </div>
              <div className="relative flex min-h-0 flex-1 items-center justify-center px-16 pb-6">
                {photo.state.kind === 'ready' ? (
                  <div
                    className={clsx(
                      'relative flex size-full items-center justify-center overflow-hidden',
                      zoom === null ? 'cursor-zoom-in' : 'cursor-zoom-out',
                    )}
                    onClick={(event) => setZoom(zoom === null ? origin(event) : null)}
                    onMouseMove={(event) => {
                      if (zoom !== null) setZoom(origin(event));
                    }}
                  >
                    <img
                      src={photo.state.uri}
                      alt={photo.caption}
                      draggable={false}
                      style={
                        zoom === null
                          ? undefined
                          : {
                              transform: 'scale(2.5)',
                              transformOrigin: `${String(zoom.x)}% ${String(zoom.y)}%`,
                            }
                      }
                      className="size-full select-none object-contain"
                    />
                  </div>
                ) : (
                  <div className="h-[60vh] w-[45vh] overflow-hidden rounded-sm">
                    <PhotoFace state={photo.state} labels={labels} alt={photo.caption} />
                  </div>
                )}
                {photos.length < 2 ? null : (
                  <>
                    <Tooltip label={labels.previous} shortcut="←">
                      <button
                        type="button"
                        aria-label={labels.previous}
                        onClick={() => go(-1)}
                        className="absolute left-3 top-1/2 flex size-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 hover:bg-white/25"
                      >
                        <ChevronLeft size={24} aria-hidden />
                      </button>
                    </Tooltip>
                    <Tooltip label={labels.next} shortcut="→">
                      <button
                        type="button"
                        aria-label={labels.next}
                        onClick={() => go(1)}
                        className="absolute right-3 top-1/2 flex size-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 hover:bg-white/25"
                      >
                        <ChevronRight size={24} aria-hidden />
                      </button>
                    </Tooltip>
                  </>
                )}
              </div>
            </>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
