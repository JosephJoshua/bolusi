/**
 * Icon — the ONLY sanctioned path to `@expo/vector-icons` (design-system §7).
 *
 * Screens name a SEMANTIC role (`pending`, `rejected`, `back`), never a glyph. Two reasons this
 * indirection is load-bearing rather than ceremony:
 *   1. §1.1 fixes semantic meaning ("primary = act, danger = destructive/failed"). A glyph name at
 *      a call site lets a screen quietly pick an alarming icon for a calm state — the exact
 *      mistake §4.3 ("pending is a chip, not a warning") is written to prevent.
 *   2. It keeps the icon set closed and auditable: adding a role is a visible diff here, and
 *      direct glyph imports in screens fail review (§7).
 *
 * Every glyph below was verified to exist in the `@expo/vector-icons` 15.1.1
 * MaterialCommunityIcons glyphmap; a typo would otherwise render an invisible tofu box.
 */
import MaterialCommunityIconsModule from '@expo/vector-icons/MaterialCommunityIcons.js';
import type { ColorValue } from 'react-native';

/** Semantic role → MaterialCommunityIcons glyph. The set is CLOSED (design-system §7). */
export const ICON_GLYPHS = Object.freeze({
  /** §3.5 pending sync chip — a clock, deliberately calm: the action already succeeded locally. */
  pending: 'clock-outline',
  /** §3.5 rejected sync chip / §3.6 danger banner. */
  rejected: 'alert-circle',
  /** §3.6 info banner. */
  info: 'information',
  /** §3.6 warning banner / §3.2 TextInput error adornment. */
  warning: 'alert',
  /** §3.7 success toast. */
  success: 'check-circle',
  /** §8.1 SyncChip `synced` — the silent default. */
  syncSynced: 'cloud-check-outline',
  /** §8.1 SyncChip `syncing`. */
  syncSyncing: 'cloud-sync-outline',
  /** §8.1 SyncChip `offline` — neutral, NOT an error (§4.6). */
  syncOffline: 'cloud-off-outline',
  /** §3.4 ListRow trailing chevron. */
  chevron: 'chevron-right',
  /** §8.1 header back. */
  back: 'arrow-left',
  /** §3.3 PinPad backspace key. */
  backspace: 'backspace-outline',
  /** §3.8 EmptyState. */
  empty: 'inbox-outline',
  /** §5 Error state. */
  error: 'alert-circle-outline',
  /** §5 Unauthorized state — a lock, never an empty box. */
  unauthorized: 'lock-outline',
  /** §5 Error state retry action. */
  retry: 'sync',
  /** §3.8 EmptyState create CTA. */
  add: 'plus',
  /** §8.6 module rows: a note/ticket carries a media attachment. A paperclip, not a camera —
   *  the glyph marks "has a photo", it does not invite capture (that is `media.action.takePhoto`). */
  attachment: 'paperclip',
  /** §8.1 header: the Settings entry, beside its label "Pengaturan"/"Settings" (§0 forbids an icon
   *  without a label). A cog, so a user stranded in a locale they cannot read still finds the
   *  language rows at the top of Settings by shape. */
  settings: 'cog-outline',
  /** A PIN that is locked, or the screen lock. */
  lock: 'lock-outline',
  /** Settings: PIN rows (change your own, manage staff PINs). */
  pin: 'dialpad',
  /** Settings: the language rows. */
  language: 'translate',
  /** Settings: notification rows. */
  notifications: 'bell-outline',
  /** Settings: this device's facts. */
  phoneDevice: 'cellphone',
  /** Settings: the store, on the device facts. */
  store: 'storefront-outline',
  /** Settings: staff (PIN karyawan). */
  staff: 'account-group-outline',
  /** Settings: a business list someone edits (intake options). */
  list: 'format-list-bulleted',
  /** Settings: a money setting (cancel fees). */
  money: 'cash',
  /** PhotoSlot: an empty slot asks for a photo. */
  camera: 'camera-outline',
  /** ToggleChip / PhotoSlot: selected or done — always beside a label. */
  check: 'check',
  /** Search fields: the leading glyph of a search box. */
  search: 'magnify',
  /** Repair: a technician's work (queue rows, "start work"). */
  repair: 'wrench-outline',
  /** Repair: a customer's phone number. */
  phone: 'phone-outline',
  /** PhotoSlot: an empty slot that takes the customer's signature, not a photo. */
  signature: 'draw',
  /** A compact inline action that removes one row (a price line), always beside a label. */
  remove: 'close',
  /** A compact inline action that reopens a section for editing, always beside a label. */
  edit: 'pencil-outline',
  /** SearchField: clears what was typed. */
  clear: 'close-circle',
  /** PhotoViewer: closes the full-screen view. */
  close: 'close',
  /** PhotoViewer: saves or sends the photo through the system share sheet. */
  share: 'share-variant-outline',
  /** PhotoStrip: opens every photo at once. */
  photos: 'image-multiple-outline',
  /** ReorderableList: the handle a row is dragged by, as on iOS lists; it carries an accessible
   *  label and move up/down actions, so it is never the only way to reorder. */
  dragHandle: 'drag-horizontal-variant',
  /** Avatar menu: switch to another staff member. */
  switchUser: 'account-switch-outline',
} as const);

export type IconName = keyof typeof ICON_GLYPHS;

/**
 * Interop normalisation, and why it is not paranoia:
 *
 * `@expo/vector-icons` ships bundler-only ESM inside `.js` files while declaring no
 * `"type": "module"` and no `exports` map. tsc (NodeNext) therefore models this subpath as CJS and
 * types the default import as the module NAMESPACE, whereas Metro — the only bundler this
 * Hermes-only package ever runs through — unwraps it to the component. Normalising once here keeps
 * both the compiler and the device correct.
 *
 * The single-family subpath is deliberate. The barrel (`@expo/vector-icons`) resolves to
 * `IconsLazy.js`, whose "lazy" applies only to its property getters: it eagerly `require`s all 19
 * families at module scope, pulling ~1.6 MB of glyphmaps into the bundle versus 216 KB for
 * MaterialCommunityIcons alone (measured against 15.1.1). §0's dependency-weight constraint does
 * not carry 1.4 MB for one icon set.
 */
const MaterialCommunityIcons = ('default' in MaterialCommunityIconsModule
  ? MaterialCommunityIconsModule.default
  : MaterialCommunityIconsModule) as unknown as (props: {
  name: (typeof ICON_GLYPHS)[IconName];
  size: number;
  color: ColorValue;
  testID?: string | undefined;
  accessibilityElementsHidden?: boolean;
  importantForAccessibility?: 'no';
}) => React.JSX.Element;

export interface IconProps {
  readonly name: IconName;
  readonly size: number;
  readonly color: ColorValue;
  readonly testID?: string | undefined;
}

/**
 * Icons are decorative here: they always accompany a text sibling (§6.3 forbids color-only — and
 * icon-only — signalling), so they are hidden from the screen reader to avoid double-announcing
 * what the adjacent label already says.
 */
export function Icon({ name, size, color, testID }: IconProps): React.JSX.Element {
  return (
    <MaterialCommunityIcons
      testID={testID}
      name={ICON_GLYPHS[name]}
      size={size}
      color={color}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}
