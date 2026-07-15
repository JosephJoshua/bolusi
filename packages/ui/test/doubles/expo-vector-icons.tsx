/**
 * Runtime double for `@expo/vector-icons/MaterialCommunityIcons`, aliased in `vitest.config.ts`
 * (test lane ONLY). Same rationale as the `react-native` double — see its header. Types still come
 * from the real package at compile time, so the glyph-name union is compiler-checked for real.
 *
 * The glyph `name` passes through to a host node so the §6.3 tests ("every status signal carries an
 * icon, never colour alone") can find the node and read its glyph. The icon's IDENTITY is what is
 * under test here; font rasterization belongs to the on-device suite.
 */
import React from 'react';

type AnyProps = Record<string, unknown>;

const MaterialCommunityIcons = React.forwardRef<unknown, AnyProps>(
  function MaterialCommunityIcons(props, ref) {
    return React.createElement('MaterialCommunityIcons', { ...props, ref });
  },
);

export default MaterialCommunityIcons;
