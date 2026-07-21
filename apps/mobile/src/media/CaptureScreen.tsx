/**
 * The capture surface — 06-media-pipeline §2.1 ("the shared `MediaCapture` component is the only
 * capture surface") rendered under design-system §5's mandatory states.
 *
 * ── THE ONE DESIGN DECISION EVERYTHING ELSE FOLLOWS FROM ────────────────────────────────────────
 * The viewfinder is the screen. A technician opens this holding a customer's cracked handset in the
 * other hand, in a shop with the lights on and the sun coming through the shutter (§0), and the only
 * question is "is the damage in frame". So the preview takes the entire content area, there is
 * exactly ONE control, and it is a full-width labelled button in the bottom thumb zone (§0
 * one-handed, §8.1 bottom action bar). Everything else on this screen is a state that REPLACES the
 * viewfinder rather than crowding it — because a control you have to hunt for over a live preview
 * is a control you press by accident while aiming.
 *
 * No camera glyph on the shutter: §0 is explicit that this audience gets "no icons without labels",
 * and the icon inventory (§3.5/Icon.tsx) is CLOSED — adding a camera glyph is a design-system change
 * first (§3). `media.action.takePhoto` ("Ambil Foto") is the label, and it is also the clearest
 * thing that could be written there.
 *
 * ── WHY THE PREVIEW IS A PROP ───────────────────────────────────────────────────────────────────
 * `preview` is a `ReactNode` the composition root fills with `<CameraView>`. That is not indirection
 * for its own sake — it is what makes this file RENDER-TESTABLE (task 69's finding: a model-only
 * test cannot see a broken prop). `CameraView` is a native view that cannot mount under Node, so a
 * screen that imported it directly could only ever be tested as a model, and the wiring that
 * actually gates the screen — which state renders, whether the shutter is disabled, whether the
 * refusal dialog appears — would be exactly the part no test could reach. It is the same slot
 * pattern `AppShell` already uses for `syncChip` and `avatar`.
 *
 * ── §5's FOUR STATES, AND THE HONEST ACCOUNT OF THE FOURTH ──────────────────────────────────────
 *   loading       — `permission_pending` / `warming_up`: a spinner (§3.9 — non-list content under 1 s).
 *   unauthorized  — `permission_denied`: `UnauthorizedState`, NOT an empty box (§5: denial must never
 *                   masquerade as Empty). The hint is `media.permission.camera`, the same sentence
 *                   the OS dialog shows, so the two do not contradict each other.
 *   error         — `failed` (with the code, for support) and `refused_low_storage`, which is 06 §7's
 *                   required "explicit error dialog — never a silent camera failure"; PRD-012 §6:
 *                   a silent camera death "will be discovered at the worst moment".
 *   empty         — DELIBERATELY ABSENT, and this is the sentence a reviewer should read rather than
 *                   assume an omission. §5's Empty is "a collection resolved to zero rows"; a live
 *                   viewfinder has no collection. Rendering an EmptyState here would require inventing
 *                   a zero-ness that does not exist, and §5's own rule is that Empty must never be
 *                   shown for something that is really a denial or an error — both of which this
 *                   screen has, with their own states. The signature pad next door DOES have a real
 *                   empty (an unsigned pad) and ships it.
 */
import { t } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  ErrorState,
  LoadingState,
  UnauthorizedState,
  color,
  radius,
  space,
  type BannerVariant,
} from '@bolusi/ui';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { StorageBand } from '@bolusi/core';

/**
 * What the screen is doing. A closed union rather than four booleans: `permissionDenied &&
 * capturing` is not a state this screen can be in, and a shape that can express it is a shape a
 * render can get wrong.
 */
export type CaptureScreenState =
  | { readonly kind: 'permission_pending' }
  | { readonly kind: 'permission_denied' }
  | { readonly kind: 'warming_up' }
  | { readonly kind: 'ready'; readonly band: StorageBand }
  | { readonly kind: 'capturing' }
  | { readonly kind: 'review'; readonly previewUri: string }
  | { readonly kind: 'refused_low_storage' }
  | { readonly kind: 'failed'; readonly code: string };

export interface CaptureScreenProps {
  /**
   * Already-localized screen title, supplied by the flow that opened the camera ("Foto kerusakan",
   * "Foto sebelum servis", …). NOT resolved here: 06 has no capture-screen title key and the label
   * catalog is a contended shared package this task may not extend (CLAUDE.md §4) — inventing a key
   * would be a spec edit smuggled into an implementation. The `@bolusi/ui` contract is exactly this:
   * user-visible strings arrive already localized.
   */
  readonly title: string;
  readonly state: CaptureScreenState;
  /** `<CameraView>` on a device; a plain node under test. See the header. */
  readonly preview: ReactNode;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onShutter: () => void;
  readonly onRetake: () => void;
  readonly onUsePhoto: () => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
}

/**
 * 06 §7's storage banners, as the ONE mapping from band to banner.
 *
 * `normal` and `capture_refused` both yield `null` — for opposite reasons, which is why they are
 * spelled out rather than left to a default arm. `normal` has nothing to say. `capture_refused` is
 * not a banner at all: §7 requires a REFUSAL with an explicit dialog, so it is a whole screen state
 * (`refused_low_storage`), and also drawing a banner would let the viewfinder stay on screen behind
 * it, implying a shutter that does nothing.
 */
export function storageBanner(
  band: StorageBand,
): { readonly variant: BannerVariant; readonly message: string } | null {
  switch (band) {
    case 'warning':
      return { variant: 'warning', message: t('media.storage.lowWarning') };
    case 'loud':
      return { variant: 'danger', message: t('media.storage.lowCritical') };
    case 'capture_refused':
    case 'normal':
      return null;
  }
}

export function CaptureScreen({
  title,
  state,
  preview,
  syncChip,
  avatar,
  onShutter,
  onRetake,
  onUsePhoto,
  onRetry,
  onBack,
}: CaptureScreenProps): React.JSX.Element {
  const banner = state.kind === 'ready' ? storageBanner(state.band) : null;

  return (
    <AppShell
      title={title}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={syncChip}
      avatar={avatar}
      banner={
        banner === null ? undefined : (
          <Banner
            variant={banner.variant}
            message={banner.message}
            testID="capture-storage-banner"
          />
        )
      }
      bottomAction={bottomAction(state, { onShutter, onRetake, onUsePhoto })}
      testID="capture-screen"
    >
      {content(state, preview, { onRetry, onBack })}
    </AppShell>
  );
}

/**
 * The bottom action bar.
 *
 * `review` is the ONE state with two buttons, and they are deliberately NOT adjacent primaries:
 * "Foto Ulang" is secondary and sits above "Pakai Foto Ini", which is the primary. §3.1 allows one
 * visible primary per screen, and the stack (rather than a row) is what keeps both at the full
 * `touch.primary` height with §1.4's 8 dp separation on a 360 dp screen where Indonesian labels run
 * long ("Pakai Foto Ini" is 14 characters).
 *
 * Every other state renders NO action, including the error states — their retry lives inside
 * `ErrorState` (§5: "retry action"), and a second retry in the action bar would be two controls for
 * one intent.
 */
function bottomAction(
  state: CaptureScreenState,
  handlers: {
    readonly onShutter: () => void;
    readonly onRetake: () => void;
    readonly onUsePhoto: () => void;
  },
): ReactNode {
  if (state.kind === 'review') {
    return (
      <View style={styles.reviewActions}>
        <Button
          label={t('media.action.retake')}
          variant="secondary"
          onPress={handlers.onRetake}
          testID="capture-retake"
        />
        <Button
          label={t('media.action.usePhoto')}
          onPress={handlers.onUsePhoto}
          testID="capture-use"
        />
      </View>
    );
  }
  if (state.kind !== 'ready' && state.kind !== 'capturing') return null;
  return (
    <Button
      label={t('media.action.takePhoto')}
      onPress={handlers.onShutter}
      // §3.1: `busy` is for LOCAL work only, never a network wait — and this IS local work. The
      // shutter stays busy through the encode/downscale/hash/move (06 §2.2 steps 3–6), which is
      // real CPU on a 2 GB device and the one moment a second press would produce a duplicate row.
      //
      // `busy` ALONE, with no companion `disabled`. There was one, and it was a line NOTHING COULD
      // SEE CHANGE: `Button` computes `inert = disabled || busy` and drives the Pressable's
      // `disabled`, its `accessibilityState` and its `onPress` gating from `inert` — so with `busy`
      // true, flipping `disabled` to a constant `false` left every rendered prop identical and the
      // render test green. Found by breaking it and watching the suite stay green (§2.11), which is
      // the whole point of falsifying rather than reading. A prop whose value no observer can
      // distinguish is worse than absent: it reads as the guard.
      busy={state.kind === 'capturing'}
      testID="capture-shutter"
    />
  );
}

function content(
  state: CaptureScreenState,
  preview: ReactNode,
  handlers: { readonly onRetry: () => void; readonly onBack: () => void },
): ReactNode {
  switch (state.kind) {
    case 'permission_pending':
    case 'warming_up':
      return <LoadingState variant="spinner" testID="capture-loading" />;

    case 'permission_denied':
      return (
        <UnauthorizedState
          title={t('media.permission.camera')}
          hint={t('auth.revoked.body')}
          backLabel={t('core.action.back')}
          onBack={handlers.onBack}
          testID="capture-unauthorized"
        />
      );

    case 'refused_low_storage':
      return (
        <ErrorState
          title={t('media.capture.refusedTitle')}
          hint={t('media.capture.refusedBody')}
          retryLabel={t('core.action.retry')}
          onRetry={handlers.onRetry}
          testID="capture-refused"
        />
      );

    case 'failed':
      return (
        <ErrorState
          title={t('core.errors.UNEXPECTED')}
          // §5: the code, in `type.caption`, for support. Never the raw exception text.
          errorCode={state.code}
          retryLabel={t('core.action.retry')}
          onRetry={handlers.onRetry}
          testID="capture-failed"
        />
      );

    case 'ready':
    case 'capturing':
      return (
        <View style={styles.viewfinder} testID="capture-viewfinder">
          {preview}
        </View>
      );

    case 'review':
      // The review still frame occupies the same box the viewfinder did, so the photo appears
      // exactly where it was aimed — no jump between "what I framed" and "what I got".
      return (
        <View style={styles.viewfinder} testID="capture-review">
          {preview}
        </View>
      );
  }
}

const styles = StyleSheet.create({
  // `surfaceAlt` behind the preview, not `surface`: a white box briefly showing through while the
  // camera texture attaches reads as a broken screen in a bright shop, where white IS the ambient.
  viewfinder: {
    flex: 1,
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  reviewActions: { gap: space.sm },
});
