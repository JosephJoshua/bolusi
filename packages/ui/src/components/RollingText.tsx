/**
 * RollingText — a figure that rolls to its new value when it changes while on screen: a balance
 * that drops when a QR payment lands, a total after a price change. A rise rolls in from below and
 * a drop from above, so the direction reads before the digits do. The first value is just there.
 *
 * For a figure that changes on its own, never one the person is typing: rolling on each keystroke
 * would be noise.
 */
import type { StyleProp, TextStyle } from 'react-native';
import { Animated } from 'react-native';

import { useEntrance } from '../motion.js';
import { useChangeDirection } from '../direction.js';

export interface RollingTextProps {
  /** What the text shows as a number; its change decides the direction. */
  readonly value: number;
  /** Already-formatted, e.g. `formatMoney(value)`. */
  readonly children: string;
  /** Show changes without rolling: the figure follows something being typed. */
  readonly still?: boolean | undefined;
  readonly style?: StyleProp<TextStyle>;
  readonly testID?: string | undefined;
}

function Roll({
  from,
  children,
  style,
  testID,
}: Omit<RollingTextProps, 'value' | 'still'> & {
  readonly from: 'below' | 'above';
}): React.JSX.Element {
  const entrance = useEntrance({ from });
  return (
    <Animated.Text testID={testID} style={[style, entrance]}>
      {children}
    </Animated.Text>
  );
}

export function RollingText({
  value,
  children,
  still = false,
  style,
  testID,
}: RollingTextProps): React.JSX.Element {
  const direction = useChangeDirection(value);
  if (direction === null || still) {
    return (
      <Animated.Text testID={testID} style={style}>
        {children}
      </Animated.Text>
    );
  }
  // A new key per value plays the roll again.
  return (
    <Roll key={value} from={direction === 'up' ? 'below' : 'above'} style={style} testID={testID}>
      {children}
    </Roll>
  );
}
