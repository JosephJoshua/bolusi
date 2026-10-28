/**
 * Step transitions for a step-by-step flow: the new step's content slides in from the side it comes
 * from, from the right going forward and from the left going back. Short, so a quick hand is never
 * kept waiting. Under reduced motion the new step simply appears.
 *
 * Two halves, because a flow's content remounts on every step (AppShell `scrollKey` opens each step
 * at the top): the flow remembers the direction with `useStepDirection`, which lives above the
 * remount, and the step's content arrives inside `StepTransition`.
 */
import type { ReactNode } from 'react';
import { Animated } from 'react-native';

import { useChangeDirection } from './direction.js';
import { useEntrance } from './motion.js';
import { motion } from './tokens.js';

/** Which side the step on show came from; `null` for the flow's first step, which is just there. */
export type StepDirection = 'end' | 'start' | null;

/** Call in the flow (above the content that remounts per step) with the step on show. */
export function useStepDirection(step: number): StepDirection {
  const change = useChangeDirection(step);
  return change === null ? null : change === 'up' ? 'end' : 'start';
}

export interface StepTransitionProps {
  readonly from: StepDirection;
  readonly children: ReactNode;
  readonly testID?: string | undefined;
}

function Arrival({
  from,
  children,
  testID,
}: {
  readonly from: 'end' | 'start';
  readonly children: ReactNode;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const style = useEntrance({ from, distance: motion.distance.step });
  return (
    <Animated.View testID={testID} style={style}>
      {children}
    </Animated.View>
  );
}

/** The step's content, arriving from `from`. Mount it fresh per step (it plays on mount). */
export function StepTransition({ from, children, testID }: StepTransitionProps): React.JSX.Element {
  if (from === null) return <Animated.View testID={testID}>{children}</Animated.View>;
  return (
    <Arrival from={from} testID={testID}>
      {children}
    </Arrival>
  );
}
