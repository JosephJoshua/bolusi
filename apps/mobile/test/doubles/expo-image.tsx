/**
 * Runtime double for `expo-image` in the test lane (aliased in `vitest.config.ts`).
 *
 * Same discipline as the `react-native` double (test/doubles/react-native.tsx): the REAL types come
 * from the installed `expo-image` (tsc resolves them; this file is never in the tsconfig include), so
 * `Image`'s props stay compiler-checked. The runtime renders a plain `Image` host node with props
 * passed through UNCHANGED, so a test can read the `source` uri a screen resolved — but no real image
 * is decoded (that is the on-device suite's job; a headless lane cannot verify pixels).
 */
import React from 'react';

type AnyProps = Record<string, unknown>;

export const Image = React.forwardRef<unknown, AnyProps>(function Image(props, ref) {
  return React.createElement('Image', { ...props, ref });
});
