/**
 * PhotoViewer — a record's photos full screen: swipe between them, pinch or double-tap to zoom, drag
 * a zoomed photo around, and save or send one. Evidence photos are checked up close (a scratch, a
 * cracked corner), so the thumbnail is never the end of the road.
 *
 * Saving goes through the platform (the system share sheet on a phone: "Simpan ke Foto", Files,
 * WhatsApp to the customer), so the viewer only knows whether handing the photo over failed.
 *
 * Mounted by its owner in the AppShell `overlay` slot, like ConfirmSheet: a plain absolute layer
 * with no second view hierarchy. The owner closes it on hardware back.
 *
 * Zoom is built on RN's own `PanResponder` and `Animated`, not a gesture library: no native
 * dependency to add, and the same code runs on Android, iOS and the web harness. While a photo is
 * zoomed the pager stops paging, so dragging moves the photo instead of switching to the next one.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native';

import { NATIVE_DRIVER } from '../motion.js';

import { NAV_BAR_INSET } from '../platform-insets.js';
import { useDismissKeyboard } from '../use-dismiss-keyboard.js';
import { color, radius, size, space, touch, type } from '../tokens.js';
import { Icon } from './Icon.js';

export interface PhotoViewerItem {
  readonly key: string;
  /** Already-localized caption, e.g. "Depan". */
  readonly label: string;
}

export type PhotoShareResult = 'done' | 'failed';

export interface PhotoViewerLabels {
  readonly close: string;
  readonly share: string;
  /** "{index} dari {total}", already resolved. */
  readonly position: (index: number, total: number) => string;
  /** Said when the photo could not be handed over (not loaded yet, nothing to share with). */
  readonly shareFailed: string;
}

export interface PhotoViewerProps {
  readonly photos: readonly PhotoViewerItem[];
  readonly initialIndex: number;
  /** Renders one photo to fill its page, uncropped (`contain`). */
  readonly renderImage: (index: number) => ReactNode;
  readonly onClose: () => void;
  /** Absent ⇒ no share button (the platform cannot share). */
  readonly onShare?: ((index: number) => Promise<PhotoShareResult>) | undefined;
  readonly labels: PhotoViewerLabels;
  readonly testID?: string | undefined;
}

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
/** Movement under this many dp still counts as a tap. */
const TAP_SLOP = 10;
const NOTICE_MS = 2000;

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: color.overlay,
  },
  bar: {
    height: size.header,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.sm,
  },
  barButton: {
    width: touch.min,
    height: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barTitle: { flex: 1, alignItems: 'center' },
  label: { ...type.bodySm, fontWeight: '600', color: color.onPrimary },
  position: { ...type.caption, color: color.onPrimary },
  pager: { flex: 1 },
  page: { overflow: 'hidden' },
  fill: { flex: 1 },
  notice: {
    position: 'absolute',
    bottom: space.xl + NAV_BAR_INSET,
    alignSelf: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.full,
    backgroundColor: color.text,
  },
  noticeText: { ...type.bodySm, color: color.onPrimary },
});

export function PhotoViewer({
  photos,
  initialIndex,
  renderImage,
  onClose,
  onShare,
  labels,
  testID = 'ui.photoViewer',
}: PhotoViewerProps): React.JSX.Element {
  // A full-screen overlay too: its controls must not open under the keyboard.
  useDismissKeyboard();
  const [index, setIndex] = useState(initialIndex);
  const [page, setPage] = useState<{ width: number; height: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const pager = useRef<ScrollView>(null);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const onLayout = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    setPage({ width, height });
  };

  // Open on the tapped photo once the page width is known.
  useEffect(() => {
    if (page === null) return;
    pager.current?.scrollTo({ x: index * page.width, animated: false });
    // Only when the page size changes; scrolling itself updates `index`.
  }, [page?.width]);

  const onScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    if (page === null || page.width === 0) return;
    const next = Math.round(event.nativeEvent.contentOffset.x / page.width);
    if (next !== index && next >= 0 && next < photos.length) setIndex(next);
  };

  const share = (): void => {
    if (onShare === undefined || sharing) return;
    setSharing(true);
    void onShare(index)
      .catch((): PhotoShareResult => 'failed')
      .then((result) => {
        if (result === 'failed') setNotice(labels.shareFailed);
        setSharing(false);
      });
  };

  const current = photos[index];

  return (
    <View testID={testID} style={styles.root}>
      <View style={styles.bar}>
        <Pressable
          testID={`${testID}.close`}
          accessibilityRole="button"
          accessibilityLabel={labels.close}
          onPress={onClose}
          style={styles.barButton}
        >
          <Icon name="close" size={size.iconInline} color={color.onPrimary} />
        </Pressable>
        <View style={styles.barTitle}>
          <Text style={styles.label} numberOfLines={1} testID={`${testID}.label`}>
            {current?.label ?? ''}
          </Text>
          <Text style={styles.position} testID={`${testID}.position`}>
            {labels.position(index + 1, photos.length)}
          </Text>
        </View>
        {onShare === undefined ? (
          <View style={styles.barButton} />
        ) : (
          <Pressable
            testID={`${testID}.share`}
            accessibilityRole="button"
            accessibilityLabel={labels.share}
            accessibilityState={{ busy: sharing }}
            onPress={share}
            style={styles.barButton}
          >
            <Icon name="share" size={size.iconInline} color={color.onPrimary} />
          </Pressable>
        )}
      </View>

      <View style={styles.pager} onLayout={onLayout}>
        {page === null ? null : (
          <ScrollView
            ref={pager}
            horizontal
            pagingEnabled
            scrollEnabled={!zoomed}
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={onScrollEnd}
            onScrollEndDrag={onScrollEnd}
            testID={`${testID}.pager`}
          >
            {photos.map((photo, photoIndex) => (
              <View
                key={photo.key}
                style={[styles.page, { width: page.width, height: page.height }]}
                testID={`${testID}.page.${photo.key}`}
              >
                <ZoomableView
                  width={page.width}
                  height={page.height}
                  // A photo swiped away snaps back to fit, so it opens whole next time.
                  active={photoIndex === index}
                  onZoomChange={setZoomed}
                  testID={`${testID}.zoom.${photo.key}`}
                >
                  {renderImage(photoIndex)}
                </ZoomableView>
              </View>
            ))}
          </ScrollView>
        )}
      </View>

      {notice === null ? null : (
        <View style={styles.notice} testID={`${testID}.notice`} accessibilityLiveRegion="polite">
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}
    </View>
  );
}

interface Gesture {
  scale: number;
  x: number;
  y: number;
  startScale: number;
  startX: number;
  startY: number;
  startDistance: number;
  pinched: boolean;
  lastTap: number;
  /** Fingers down at the last move, and the drag offset when that number changed. */
  touches: number;
  offsetDx: number;
  offsetDy: number;
}

function distance(event: GestureResponderEvent): number {
  const [a, b] = event.nativeEvent.touches;
  if (a === undefined || b === undefined) return 0;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

/** Pinch, double-tap and drag on one page. Pure RN: `PanResponder` reads, `Animated` draws. */
function ZoomableView({
  width,
  height,
  active,
  onZoomChange,
  testID,
  children,
}: {
  readonly width: number;
  readonly height: number;
  readonly active: boolean;
  readonly onZoomChange: (zoomed: boolean) => void;
  readonly testID: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const gesture = useRef<Gesture>({
    scale: 1,
    x: 0,
    y: 0,
    startScale: 1,
    startX: 0,
    startY: 0,
    startDistance: 0,
    pinched: false,
    lastTap: 0,
    touches: 0,
    offsetDx: 0,
    offsetDy: 0,
  }).current;
  const zoomChange = useRef(onZoomChange);
  zoomChange.current = onZoomChange;

  const responder = useMemo(() => {
    // A zoomed photo may move only as far as its edges; it never drifts off into black.
    const clamp = (nextScale: number, x: number, y: number): [number, number, number] => {
      const s = Math.min(MAX_SCALE, Math.max(1, nextScale));
      const maxX = (width * (s - 1)) / 2;
      const maxY = (height * (s - 1)) / 2;
      return [s, Math.min(maxX, Math.max(-maxX, x)), Math.min(maxY, Math.max(-maxY, y))];
    };
    const apply = (nextScale: number, x: number, y: number, animate: boolean): void => {
      const [s, cx, cy] = clamp(nextScale, x, y);
      gesture.scale = s;
      gesture.x = cx;
      gesture.y = cy;
      if (animate) {
        Animated.parallel([
          Animated.spring(scale, { toValue: s, useNativeDriver: NATIVE_DRIVER }),
          Animated.spring(translateX, { toValue: cx, useNativeDriver: NATIVE_DRIVER }),
          Animated.spring(translateY, { toValue: cy, useNativeDriver: NATIVE_DRIVER }),
        ]).start();
      } else {
        scale.setValue(s);
        translateX.setValue(cx);
        translateY.setValue(cy);
      }
      zoomChange.current(s > 1);
    };
    const begin = (event: GestureResponderEvent): void => {
      gesture.startScale = gesture.scale;
      gesture.startX = gesture.x;
      gesture.startY = gesture.y;
      gesture.startDistance = distance(event);
    };
    return {
      apply,
      handlers: PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        // Two fingers always zoom; one finger drags only a zoomed photo, so at fit it swipes pages.
        onMoveShouldSetPanResponder: (event) =>
          event.nativeEvent.touches.length === 2 || gesture.scale > 1,
        onPanResponderGrant: (event) => {
          gesture.pinched = false;
          gesture.touches = event.nativeEvent.touches.length;
          gesture.offsetDx = 0;
          gesture.offsetDy = 0;
          begin(event);
        },
        onPanResponderMove: (event, state) => {
          const touches = event.nativeEvent.touches.length;
          // A finger lifted or added mid-gesture starts a new one from here, so the photo never
          // jumps by the distance the other finger already travelled.
          if (touches !== gesture.touches) {
            gesture.touches = touches;
            gesture.offsetDx = state.dx;
            gesture.offsetDy = state.dy;
            begin(event);
          }
          if (touches === 2) {
            gesture.pinched = true;
            const ratio = distance(event) / Math.max(1, gesture.startDistance);
            apply(gesture.startScale * ratio, gesture.startX, gesture.startY, false);
          } else if (gesture.scale > 1) {
            apply(
              gesture.scale,
              gesture.startX + state.dx - gesture.offsetDx,
              gesture.startY + state.dy - gesture.offsetDy,
              false,
            );
          }
        },
        onPanResponderRelease: (_event, state) => {
          const tapped =
            !gesture.pinched && Math.abs(state.dx) < TAP_SLOP && Math.abs(state.dy) < TAP_SLOP;
          gesture.startDistance = 0;
          if (!tapped) return;
          const now = Date.now();
          if (now - gesture.lastTap < DOUBLE_TAP_MS) {
            gesture.lastTap = 0;
            apply(gesture.scale > 1 ? 1 : DOUBLE_TAP_SCALE, 0, 0, true);
          } else {
            gesture.lastTap = now;
          }
        },
        // Let the pager take over a swipe at fit; hold on to the gesture while zoomed.
        onPanResponderTerminationRequest: () => gesture.scale <= 1,
        onPanResponderTerminate: () => {
          gesture.startDistance = 0;
        },
      }).panHandlers,
    };
  }, [width, height, gesture, scale, translateX, translateY]);

  useEffect(() => {
    if (!active && gesture.scale > 1) responder.apply(1, 0, 0, false);
  }, [active, gesture, responder]);

  return (
    <Animated.View
      testID={testID}
      {...responder.handlers}
      style={[styles.fill, { transform: [{ translateX }, { translateY }, { scale }] }]}
    >
      {children}
    </Animated.View>
  );
}
