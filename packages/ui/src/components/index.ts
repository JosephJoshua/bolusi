/**
 * The §3 component inventory — VALUE exports only.
 *
 * This barrel is load-bearing beyond convenience: `gallery/registry.ts` maps over `typeof` this
 * module, so every component listed here MUST declare its mandatory states or the build fails. Add
 * a component, get a compile error until it has Gallery coverage. That is the whole mechanism.
 *
 * Therefore: no helpers, no constants, no types-as-values here. Pure logic (`selectBanner`,
 * `resolveSyncChip`) and constants (`PIN_LENGTH`, …) are re-exported from `src/index.ts` directly
 * from their modules — they have no visual states and would only pollute the registry.
 */
export { Avatar } from './Avatar.js';
export { Banner } from './Banner.js';
export { Button } from './Button.js';
export { Card } from './Card.js';
export { Chip } from './Chip.js';
export { ConfirmSheet } from './ConfirmSheet.js';
export { EmptyState } from './EmptyState.js';
export { ErrorState } from './ErrorState.js';
export { FreshnessCell } from './FreshnessCell.js';
export { Icon } from './Icon.js';
export { List } from './List.js';
export { ListRow } from './ListRow.js';
export { LoadingState } from './LoadingState.js';
export { PinPad } from './PinPad.js';
export { SyncStatusChip } from './SyncStatusChip.js';
export { TextInput } from './TextInput.js';
export { Toast } from './Toast.js';
export { UnauthorizedState } from './UnauthorizedState.js';
