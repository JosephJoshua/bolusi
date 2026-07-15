/**
 * Android hardware back → the header back action (design-system §8.1: "hardware back always equals
 * the header back action").
 *
 * This file is a THIN ADAPTER on purpose, and the split is the point: the DECISION ("what does back
 * do here?") lives in `zone.ts`'s `backTarget` — pure, total, and tested directly — while this hook
 * owns only the native subscription. Nothing here can disagree with the header, because the header
 * renders from the same `backTarget`.
 *
 * `handler` returns true to CONSUME the press, false to let Android do its default (exit the app).
 * That maps exactly onto `backTarget(zone) === null` meaning "there is nothing to go back to" — see
 * `zone.ts` for why the lock switcher deliberately has no back.
 */
import { useEffect } from 'react';
import { BackHandler } from 'react-native';

/**
 * Subscribe `handler` to Android's hardware back for as long as the component is mounted.
 *
 * The subscription is re-created whenever `handler` changes: RN runs listeners most-recent-first and
 * the first `true` consumes the event, so a stale closure left registered would answer for a screen
 * that is no longer on top. The cleanup is what keeps "back belongs to the visible screen" true.
 */
export function useHardwareBack(handler: () => boolean): void {
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', handler);
    return () => subscription.remove();
  }, [handler]);
}
