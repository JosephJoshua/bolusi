/**
 * `@bolusi/ui` — the design system (design-system.md is the owning doc).
 *
 * CONTENDED SHARED PACKAGE (CLAUDE.md §4): changes serialize and land before dependents (24/25).
 *
 * Two contracts every consumer must know:
 *   1. Every user-visible string arrives as an ALREADY-LOCALIZED prop. This package contains no
 *      literals and never calls `t()` — screens resolve labels from the catalog (07-i18n).
 *   2. Tokens are the only styling vocabulary. There are no style-override props by design (§1.1
 *      fixes semantic meaning); a new look is a new variant, and that is a design-system change.
 */

// ---- Tokens (design-system §1) -----------------------------------------------------------------
export {
  border,
  color,
  contrastPairs,
  identityPalette,
  motion,
  overlayOpacity,
  radius,
  size,
  space,
  numeric,
  touch,
  type,
} from './tokens.js';
export type { ContrastPair } from './tokens.js';

// ---- Motion (native driver, reduce-motion aware) ----------------------------------------------
export {
  NATIVE_DRIVER,
  easeEnter,
  easeExit,
  useEntrance,
  usePop,
  usePressScale,
  useReducedMotion,
  useSheetEntrance,
} from './motion.js';
export type { EntranceFrom, EntranceOptions } from './motion.js';

// ---- Brand ------------------------------------------------------------------------------------
export { brandMarkWidth } from './components/BrandMark.js';

// ---- Platform insets (system-window measurements, NOT design tokens — task 205) -----------------
export { NAV_BAR_INSET } from './platform-insets.js';

// ---- Room on screen (phone, tablet) -------------------------------------------------------------
export { ViewportProvider, breakpoint, useViewport, widthClassOf } from './viewport.js';
export type { Viewport, WidthClass } from './viewport.js';

// ---- Component inventory (design-system §3) ----------------------------------------------------
export * from './components/index.js';
export * from './shell/index.js';

// ---- Component types ---------------------------------------------------------------------------
export type { AvatarProps, AvatarSize } from './components/Avatar.js';
export type {
  BannerProps,
  BannerCause,
  BannerVariant,
  SelectedBanner,
  StalenessLevel,
} from './components/Banner.js';
export type { FreshnessCellProps } from './components/FreshnessCell.js';
export type { ListProps, ListState } from './components/List.js';
export type { BrandMarkPart, BrandMarkProps } from './components/BrandMark.js';
export type { ButtonProps, ButtonVariant } from './components/Button.js';
export type { CardProps } from './components/Card.js';
export type { ChipProps, ChipTone } from './components/Chip.js';
export type { ActionChipProps } from './components/ActionChip.js';
export type { ChipRowProps } from './components/ChipRow.js';
export type { ChoiceChipsProps } from './components/ChoiceChips.js';
export type { ConfirmSheetProps } from './components/ConfirmSheet.js';
export type { EmptyStateProps } from './components/EmptyState.js';
export type { FactProps } from './components/Fact.js';
export type { OutcomeStateProps, OutcomeTone } from './components/OutcomeState.js';
export type { ErrorStateProps } from './components/ErrorState.js';
export type { IconName, IconProps } from './components/Icon.js';
export type { ListRowProps } from './components/ListRow.js';
export type { LoadingStateProps } from './components/LoadingState.js';
export type { PhotoSlotProps } from './components/PhotoSlot.js';
export type { PhotoStripItem, PhotoStripProps } from './components/PhotoStrip.js';
export type {
  PhotoShareResult,
  PhotoViewerItem,
  PhotoViewerLabels,
  PhotoViewerProps,
} from './components/PhotoViewer.js';
export type { PatternLockProps } from './components/PatternLock.js';
export type { PinPadProps, PinPadState } from './components/PinPad.js';
export type { QuantityStepperProps } from './components/QuantityStepper.js';
export type { SearchFieldProps } from './components/SearchField.js';
export type { SegmentedControlProps, SegmentedOption } from './components/SegmentedControl.js';
export type { ReorderableListProps } from './components/ReorderableList.js';
export type { SheetProps } from './components/Sheet.js';
export type { SwitchRowProps } from './components/SwitchRow.js';
export type { StepHeaderProps } from './components/StepHeader.js';
export type {
  OperationSyncStatus,
  SyncChipKind,
  SyncStatusChipProps,
} from './components/SyncStatusChip.js';
export type { TextButtonProps } from './components/TextButton.js';
export type { TextInputProps } from './components/TextInput.js';
export type { TimelineEntry, TimelineProps } from './components/Timeline.js';
export type { ToastProps, ToastTone } from './components/Toast.js';
export type { ToggleChipProps } from './components/ToggleChip.js';
export type { UnauthorizedStateProps } from './components/UnauthorizedState.js';
export type { AppShellProps } from './shell/AppShell.js';
export { useScrollLock, type ScrollLock } from './shell/scroll-lock.js';
export type { AvatarButtonProps } from './shell/AvatarButton.js';
export type { SyncChipProps, SyncChipState } from './shell/SyncChip.js';
export type { TabBarProps, TabBarTab } from './shell/TabBar.js';

// ---- Pure logic + constants --------------------------------------------------------------------
// Deliberately NOT re-exported through the component barrels: those are mapped over by the Gallery
// state registry, and only things with visual states belong there.
export { identityColor } from './components/Avatar.js';
export { BANNER_MESSAGE_LINES, selectBanner } from './components/Banner.js';
export { ICON_GLYPHS } from './components/Icon.js';
export { LOADING_DELAY_MS, SKELETON_ROW_COUNT } from './components/LoadingState.js';
export { PIN_LENGTH } from './components/PinPad.js';
export { resolveSyncChip } from './components/SyncStatusChip.js';
export { TOAST_AUTO_HIDE_MS } from './components/Toast.js';

// ---- Dev-only Gallery (design-system §9 review surface) -----------------------------------------
export { Gallery } from './gallery/Gallery.js';
export { stateRegistry } from './gallery/registry.js';
export type { GalleryProps } from './gallery/Gallery.js';
export type { GalleryLabels, GalleryState, InventoryName } from './gallery/registry.js';
