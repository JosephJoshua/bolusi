/**
 * The signature pad — 06-media-pipeline §2.3, under design-system §5's mandatory states.
 *
 * §2.1: "Signatures are captured on an in-app signature pad component rendering to PNG — never
 * imported, never photographed." So this is the only place a customer's mark can be made, and it
 * has to work first time, standing at a counter, with a finger, on a phone someone else is holding.
 *
 * ── HOW THE INK IS DRAWN WITHOUT A CANVAS ───────────────────────────────────────────────────────
 * The pinned stack (08 §2.2) has no SVG, no Skia, no canvas, and no gesture library, and adding one
 * is a spec change rather than an implementation detail (CLAUDE.md §4). So each pen segment is one
 * absolutely-positioned `View`: a rectangle `space.xs` tall, as wide as the distance between two
 * consecutive touch samples, rotated to the angle between them. That produces a CONTINUOUS line at
 * any drawing speed (a dot per sample would break into beads on a fast stroke), at a cost of one
 * view per sample — a few hundred for a real signature, which is the same order as a list screen.
 *
 * `segmentsFor` is pure and does the geometry, so the arithmetic that decides whether the stroke a
 * customer sees matches the stroke that gets encoded is testable without a touch screen. What is
 * NOT testable here, and is not claimed: how it FEELS. Touch latency, sample rate, and palm
 * rejection are device properties, and there is no device on this infrastructure (D12/D13) — on
 * either platform.
 *
 * Touch handling is RN's built-in responder system (`onStartShouldSetResponder` and friends), not a
 * gesture library: it is one prop set, it is what `PanResponder` itself is built on, and it keeps
 * the whole screen mountable in the test lane.
 *
 * ── §5's FOUR STATES, ALL FOUR REAL HERE ────────────────────────────────────────────────────────
 *   loading       — `loading`: the caller is still resolving whether this record already carries a
 *                   signature. A pad that accepts strokes before that answer arrives can silently
 *                   replace evidence (FR-819: a media ref, once attached, can never be replaced).
 *   empty         — an untouched pad. A REAL empty, and the one place this flow can invite an
 *                   action: the prompt sits behind the drawing surface and vanishes at first touch.
 *   error         — `refused_low_storage` (06 §7's explicit dialog) and `failed`, with the code.
 *   unauthorized  — `unauthorized`: the signed-in user may not sign off this work (02-permissions).
 *                   Distinct from empty, with a back CTA, per §5.
 */
import { t } from '@bolusi/i18n';
import {
  AppShell,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  UnauthorizedState,
  border,
  color,
  radius,
  space,
} from '@bolusi/ui';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { SignaturePoint, SignatureStroke } from './signature-png.js';

export type SignaturePadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'refused_low_storage' }
  | { readonly kind: 'failed'; readonly code: string };

/** One drawn segment, in pad-space pixels. `angle` is degrees, as RN's `rotate` transform wants. */
export interface InkSegment {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly angle: number;
}

/** On-screen ink thickness. `space.xs` (4 dp) is the closed scale's smallest step (§1.3). */
const INK_THICKNESS = space.xs;

/**
 * Turn strokes into drawable segments.
 *
 * A single-point stroke becomes a zero-length segment — a dot — rather than nothing, for the same
 * reason the rasteriser stamps it: dropping it would erase the tittle on a "j" and every deliberate
 * full stop. `top` is offset by half the thickness so the segment is CENTRED on the path; without
 * that, every line sits `INK_THICKNESS / 2` below where the finger was, which is exactly the
 * mismatch that makes a pad feel broken.
 */
export function segmentsFor(strokes: readonly SignatureStroke[]): readonly InkSegment[] {
  const segments: InkSegment[] = [];
  const half = INK_THICKNESS / 2;
  for (const stroke of strokes) {
    if (stroke.length === 1) {
      const only = stroke[0];
      if (only !== undefined) {
        segments.push({ left: only.x - half, top: only.y - half, width: INK_THICKNESS, angle: 0 });
      }
      continue;
    }
    for (let index = 1; index < stroke.length; index += 1) {
      const from: SignaturePoint | undefined = stroke[index - 1];
      const to: SignaturePoint | undefined = stroke[index];
      if (from === undefined || to === undefined) continue;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      segments.push({
        left: from.x,
        top: from.y - half,
        // `+ INK_THICKNESS` closes the joint between consecutive segments; without it a fast,
        // curved stroke shows hairline gaps at every direction change.
        width: Math.hypot(dx, dy) + INK_THICKNESS,
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
      });
    }
  }
  return segments;
}

export interface SignaturePadScreenProps {
  /** Already-localized — see `CaptureScreen`'s `title` for why this is a prop and not a `t()` call. */
  readonly title: string;
  readonly state: SignaturePadState;
  /** The strokes drawn so far, in pad-space. Owned by the caller so the pad itself is stateless. */
  readonly strokes: readonly SignatureStroke[];
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onStrokeStart: (point: SignaturePoint) => void;
  readonly onStrokeMove: (point: SignaturePoint) => void;
  readonly onStrokeEnd: () => void;
  readonly onClear: () => void;
  readonly onSave: () => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
}

export function SignaturePadScreen({
  title,
  state,
  strokes,
  syncChip,
  avatar,
  onStrokeStart,
  onStrokeMove,
  onStrokeEnd,
  onClear,
  onSave,
  onRetry,
  onBack,
}: SignaturePadScreenProps): React.JSX.Element {
  const hasStrokes = strokes.some((stroke) => stroke.length > 0);

  return (
    <AppShell
      title={title}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={syncChip}
      avatar={avatar}
      bottomAction={
        state.kind === 'ready' || state.kind === 'saving' ? (
          <View style={styles.actions}>
            <Button
              // "Hapus" — the catalog's word for erase (`core.action.delete`). Secondary, and above
              // the primary rather than beside it: §3.1 keeps a destructive-feeling control away
              // from the one that commits, because at a counter the two get pressed by feel.
              label={t('core.action.delete')}
              variant="secondary"
              onPress={onClear}
              // Nothing to clear is nothing to press. §3.1's disabled state still announces itself
              // to accessibility, so this reads as "not yet" rather than as a dead control.
              disabled={!hasStrokes || state.kind === 'saving'}
              testID="signature-clear"
            />
            <Button
              label={t('core.action.save')}
              onPress={onSave}
              // An unsigned pad cannot be saved: a blank white PNG is a valid file that would sit
              // in the record as an acknowledgement nobody gave (see `signature.ts`'s `refused_empty`,
              // which is the same rule enforced again where it cannot be bypassed by a UI bug).
              disabled={!hasStrokes || state.kind === 'saving'}
              // LOCAL work (§3.1): rasterise, encode, hash, move, insert. Never a network wait.
              busy={state.kind === 'saving'}
              testID="signature-save"
            />
          </View>
        ) : undefined
      }
      testID="signature-screen"
    >
      {content(state, strokes, hasStrokes, {
        onStrokeStart,
        onStrokeMove,
        onStrokeEnd,
        onRetry,
        onBack,
      })}
    </AppShell>
  );
}

function content(
  state: SignaturePadState,
  strokes: readonly SignatureStroke[],
  hasStrokes: boolean,
  handlers: {
    readonly onStrokeStart: (point: SignaturePoint) => void;
    readonly onStrokeMove: (point: SignaturePoint) => void;
    readonly onStrokeEnd: () => void;
    readonly onRetry: () => void;
    readonly onBack: () => void;
  },
): ReactNode {
  switch (state.kind) {
    case 'loading':
      return <LoadingState variant="spinner" testID="signature-loading" />;

    case 'unauthorized':
      return (
        <UnauthorizedState
          title={t('core.errors.PERMISSION_DENIED')}
          backLabel={t('core.action.back')}
          onBack={handlers.onBack}
          testID="signature-unauthorized"
        />
      );

    case 'refused_low_storage':
      return (
        <ErrorState
          title={t('media.capture.refusedTitle')}
          hint={t('media.capture.refusedBody')}
          retryLabel={t('core.action.retry')}
          onRetry={handlers.onRetry}
          testID="signature-refused"
        />
      );

    case 'failed':
      return (
        <ErrorState
          title={t('core.errors.UNEXPECTED')}
          errorCode={state.code}
          retryLabel={t('core.action.retry')}
          onRetry={handlers.onRetry}
          testID="signature-failed"
        />
      );

    case 'ready':
    case 'saving':
      return (
        <View style={styles.pad} testID="signature-pad">
          {/* §5's Empty, BEHIND the drawing surface so the first touch reaches the pad and not a
              prompt that has to be dismissed. It disappears the moment there is ink. */}
          {hasStrokes ? null : (
            <View style={styles.prompt} testID="signature-empty">
              <EmptyState title={t('core.status.empty')} testID="signature-empty-state" />
            </View>
          )}
          <View
            style={styles.surface}
            testID="signature-surface"
            // RN's responder system. `onStartShouldSetResponder` must return true for the view to
            // receive the gesture at all — returning it from a handler that also did work would
            // couple "do I own this touch" to "record a point", which is how a pad drops its first
            // sample and every signature starts a few pixels late.
            onStartShouldSetResponder={() => state.kind === 'ready'}
            onMoveShouldSetResponder={() => state.kind === 'ready'}
            onResponderGrant={(event) => {
              handlers.onStrokeStart({
                x: event.nativeEvent.locationX,
                y: event.nativeEvent.locationY,
              });
            }}
            onResponderMove={(event) => {
              handlers.onStrokeMove({
                x: event.nativeEvent.locationX,
                y: event.nativeEvent.locationY,
              });
            }}
            onResponderRelease={handlers.onStrokeEnd}
            // A gesture taken away mid-stroke (a system dialog, a call) ENDS the stroke rather than
            // leaving it open — otherwise the next touch is joined to the abandoned one by a straight
            // line across the whole pad.
            onResponderTerminate={handlers.onStrokeEnd}
          >
            {segmentsFor(strokes).map((segment, index) => (
              <View
                // Segments are append-only and never reordered, so the index IS a stable identity
                // here; a synthesised key would be a different value on every render for no gain.
                key={index}
                testID="signature-ink"
                style={[
                  styles.ink,
                  {
                    left: segment.left,
                    top: segment.top,
                    width: segment.width,
                    transform: [{ rotate: `${segment.angle}deg` }],
                  },
                ]}
              />
            ))}
          </View>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  // A bordered white field: §2.3 pins "white background, black stroke", and the hairline is what
  // tells a customer where the paper ends. No shadow (§1.3 — depth is border + surfaceAlt here).
  pad: {
    flex: 1,
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.md,
    borderWidth: border.hairline,
    overflow: 'hidden',
  },
  // Spelled out rather than `StyleSheet.absoluteFill`: RN 0.86 types that as a registered style ID,
  // which cannot be spread into an object style, and the test lane's `StyleSheet` double has no
  // such registry at all. Four zeroes are exempt from `bolusi/no-token-literals` for exactly this
  // (they carry no scale meaning) and they behave identically under both.
  prompt: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  surface: { flex: 1 },
  ink: {
    position: 'absolute',
    height: INK_THICKNESS,
    backgroundColor: color.text,
    // Rotation happens about the view's centre by default, but the geometry above is expressed from
    // the segment's START point — so the origin is pinned to the left edge and the line grows the
    // way the finger moved.
    transformOrigin: 'left center',
    borderRadius: radius.full,
  },
  actions: { gap: space.sm },
});
