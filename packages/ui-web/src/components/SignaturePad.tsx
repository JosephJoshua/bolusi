// A signature drawn on screen with a finger, pen or mouse: strokes on a white pad, "clear" to
// start again. The kept signature is its strokes, in the pad's 800 x 400 space, so the core can
// render the PNG with the same code as the phone. Copy comes from the caller.
import { Eraser } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Banner } from './Banner.js';
import { Button } from './Button.js';
import { Dialog } from './Dialog.js';

export interface SignatureLabels {
  readonly close: string;
  readonly hint: string;
  readonly clear: string;
  readonly use: string;
  /** Keeping the signature failed (storage); the pad stays to try again. */
  readonly saveFailed: string;
}

/** One pen-down to pen-up path. */
export type SignatureStroke = readonly { readonly x: number; readonly y: number }[];

export interface DrawnSignature {
  readonly strokes: readonly SignatureStroke[];
  /** The space the points are in: the pad's own pixels, whatever size it is shown at. */
  readonly pad: { readonly width: number; readonly height: number };
}

/** The pad's size: the phone's signature canvas, so a point means the same on both. */
export const SIGNATURE_PX = { width: 800, height: 400 } as const;
const STROKE_PX = 4;

/** A white pad with the pen set up. */
function paint(pad: HTMLCanvasElement): void {
  const context = pad.getContext('2d');
  if (context === null) return;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, SIGNATURE_PX.width, SIGNATURE_PX.height);
  context.lineWidth = STROKE_PX;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = '#111111';
}

export function SignatureDialog({
  open,
  title,
  labels,
  onUse,
  onClose,
  fallback,
  testId = 'signature',
}: {
  readonly open: boolean;
  readonly title: string;
  readonly labels: SignatureLabels;
  /** The drawn strokes. Resolve when they are stored; a rejection keeps the pad to retry. */
  readonly onUse: (signature: DrawnSignature) => Promise<void>;
  readonly onClose: () => void;
  /** Beside "clear", such as "Pakai HP" to sign on a phone instead. */
  readonly fallback?: React.ReactNode;
  readonly testId?: string;
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef<number | null>(null);
  const strokes = useRef<{ x: number; y: number }[][]>([]);
  const [empty, setEmpty] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const reset = (): void => {
    strokes.current = [];
    setEmpty(true);
    if (canvas.current !== null) paint(canvas.current);
  };
  // The pad mounts with the dialog; each opening starts blank.
  const attach = useCallback((node: HTMLCanvasElement | null) => {
    canvas.current = node;
    if (node !== null) paint(node);
  }, []);
  useEffect(() => {
    if (!open) return;
    strokes.current = [];
    setEmpty(true);
    setSaveFailed(false);
  }, [open]);

  /** The pointer in canvas pixels, whatever size the pad is drawn at. */
  const point = (event: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const box = event.currentTarget.getBoundingClientRect();
    return [
      ((event.clientX - box.left) / box.width) * SIGNATURE_PX.width,
      ((event.clientY - box.top) / box.height) * SIGNATURE_PX.height,
    ];
  };

  const down = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = event.pointerId;
    const [x, y] = point(event);
    strokes.current.push([{ x, y }]);
    setEmpty(false);
    const context = event.currentTarget.getContext('2d');
    if (context === null) return;
    context.beginPath();
    context.moveTo(x, y);
    // A tap leaves a dot.
    context.lineTo(x + 0.1, y + 0.1);
    context.stroke();
  };
  const move = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (drawing.current !== event.pointerId) return;
    const [x, y] = point(event);
    strokes.current.at(-1)?.push({ x, y });
    const context = event.currentTarget.getContext('2d');
    if (context === null) return;
    context.lineTo(x, y);
    context.stroke();
  };
  const up = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (drawing.current === event.pointerId) drawing.current = null;
  };

  const use = (): void => {
    if (empty) return;
    setSaving(true);
    setSaveFailed(false);
    void onUse({ strokes: strokes.current.map((stroke) => [...stroke]), pad: SIGNATURE_PX })
      .catch(() => setSaveFailed(true))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open={open}
      onRequestClose={onClose}
      title={title}
      description={labels.hint}
      closeLabel={labels.close}
      size="lg"
      testId={testId}
      banner={saveFailed ? <Banner tone="danger" message={labels.saveFailed} /> : undefined}
      footer={
        <>
          <Button
            label={labels.clear}
            icon={Eraser}
            variant="text"
            onClick={reset}
            disabled={empty || saving}
            data-testid={`${testId}.clear`}
          />
          <span className="mr-auto">{fallback}</span>
          <Button
            label={labels.use}
            variant="primary"
            onClick={use}
            disabled={empty}
            busy={saving}
            data-testid={`${testId}.use`}
          />
        </>
      }
    >
      <canvas
        ref={attach}
        width={SIGNATURE_PX.width}
        height={SIGNATURE_PX.height}
        aria-label={title}
        role="img"
        data-testid={`${testId}.pad`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className="aspect-[2/1] w-full cursor-crosshair touch-none rounded-sm border border-border bg-white"
      />
    </Dialog>
  );
}
