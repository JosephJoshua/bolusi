/**
 * Which way a number on screen last moved, for motion that shows the direction of a change: the
 * next step of a flow arriving from the right, a balance rolling down. Platform-free, so the phone
 * and the PC share it.
 */
import { useRef } from 'react';

/** `null` until the value first changes. */
export type ChangeDirection = 'up' | 'down' | null;

export function useChangeDirection(value: number): ChangeDirection {
  // Updated while rendering, so the direction is known on the very frame the new value shows; a
  // re-render with the same value keeps it.
  const last = useRef<{ value: number; direction: ChangeDirection }>({ value, direction: null });
  if (last.current.value !== value) {
    last.current = { value, direction: value > last.current.value ? 'up' : 'down' };
  }
  return last.current.direction;
}
