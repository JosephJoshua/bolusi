/**
 * Avatar (design-system §3.12, §8.2) — identity, recognised rather than read.
 *
 * PRD-011 §6.1 is the brief: these users identify themselves by FACE far faster than by reading a
 * name, and "a wall of names in an unfamiliar script — for an employee whose literacy may be
 * limited — is a barrier where a face is not." So identity is a visual object here, not a text
 * label with a decorative disc next to it.
 *
 * v0 ships no photo-upload UI (roadmap), though the directory carries `photoMediaId` from day one.
 * That makes the initials fallback the ONLY v0 rendering — so it is designed to be good, not to
 * apologise for a missing photo:
 *
 *   - EVERY USER GETS A STABLE, DISTINCT HUE, derived deterministically from their `userId`. That
 *     turns a name into a two-channel object — colour + letterform — which is recognisable in
 *     peripheral vision, at arm's length, without reading. On a shared counter device the whole job
 *     is "is that me?" answered in under a second (NFR-1003 budget: whole switch ≤ 5 s).
 *   - The hue is derived from the ID, not the name: it must not change when someone is renamed, and
 *     two people with the same initials must still differ.
 *   - Initials are TEXT, so colour is never the only signal (§6.3). The hue is an accelerator, not
 *     the information.
 *   - Every identity hue is contrast-validated against `onIdentity` in `tokens.ts`, so no user can
 *     be dealt an unreadable disc.
 *
 * A photo slots into this exact geometry later with zero layout change (§8.2), which is why `size`
 * is a token-backed diameter rather than something callers invent.
 */
import { StyleSheet, Text, View } from 'react-native';

import { color, identityPalette, radius, size, type } from '../tokens.js';

export type AvatarSize = 'row' | 'header' | 'switcher';

export interface AvatarProps {
  /** Stable user id — the hue seed. NOT the name: renaming must not repaint a person. */
  readonly userId: string;
  /**
   * Caller-computed initials, 1–2 characters. Name→initials is locale-sensitive and Indonesian
   * mononyms are common ("Yosia"), so the design system does not guess at it.
   */
  readonly initials: string;
  readonly size?: AvatarSize | undefined;
  readonly testID?: string | undefined;
}

const DIAMETER: Record<AvatarSize, number> = {
  /** §3.4 ListRow leading slot. */
  row: size.avatarRow,
  /** §8.1 header. */
  header: size.avatar,
  /** §8.2 User Switcher grid — big enough to be a face, not a bullet point. */
  switcher: size.avatarSwitcher,
};

const TYPE: Record<AvatarSize, object> = {
  row: type.bodySm,
  header: type.bodyBold,
  switcher: type.display,
};

/**
 * FNV-1a over the id. Any stable hash works; what matters is that it is deterministic across
 * devices and rebuilds — two technicians looking at two phones must see the same person in the same
 * colour, or the colour is worse than useless.
 */
function hueIndex(userId: string, buckets: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % buckets;
}

/** Exported for the Gallery and for tests: the identity hue is a pure function of the id. */
export function identityColor(userId: string): string {
  return identityPalette[hueIndex(userId, identityPalette.length)] ?? identityPalette[0]!;
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.full },
  initials: { color: color.onIdentity },
});

export function Avatar({
  userId,
  initials,
  size: avatarSize = 'header',
  testID = 'ui.avatar',
}: AvatarProps): React.JSX.Element {
  const diameter = DIAMETER[avatarSize];

  return (
    <View
      testID={testID}
      style={[
        styles.base,
        { width: diameter, height: diameter, backgroundColor: identityColor(userId) },
      ]}
    >
      <Text
        testID={`${testID}.initials`}
        // Never scale the initials down to fit: 2 characters always fit, and a shrinking letterform
        // would break the recognise-don't-read contract above.
        numberOfLines={1}
        allowFontScaling={false}
        style={[TYPE[avatarSize], styles.initials]}
      >
        {initials}
      </Text>
    </View>
  );
}
