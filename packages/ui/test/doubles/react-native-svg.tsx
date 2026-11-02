/**
 * Runtime double for `react-native-svg` (native module, test lane only). Each element is a plain
 * host node with its props, so a test can read what was drawn; nothing is rasterised.
 */
import React from 'react';

type AnyProps = Record<string, unknown>;

function host(type: string) {
  const Component = (props: AnyProps): React.ReactElement => React.createElement(type, props);
  Component.displayName = type;
  return Component;
}

export const Svg = host('Svg');
export const Circle = host('Circle');
export const Path = host('Path');
export const G = host('G');
export const Defs = host('Defs');
export const LinearGradient = host('LinearGradient');
export const Stop = host('Stop');
export const Rect = host('Rect');
