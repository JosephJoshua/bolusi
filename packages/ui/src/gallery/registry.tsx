/**
 * The state registry — component → every mandatory state it must be able to render.
 *
 * This is the single source that drives BOTH the Gallery screen and the coverage test
 * (`test/gallery-coverage.test.tsx`), which is the point: a reviewer never has to remember that
 * "Button has four states". Two independent locks enforce it:
 *
 *   1. COMPILE-TIME — `stateRegistry` is typed `Record<InventoryName, …>`, and `InventoryName` is
 *      derived from `typeof` the component/shell barrels. Export a new component without a registry
 *      entry and `tsc` fails. The list is never hand-maintained in two places.
 *   2. RUN-TIME — the coverage test walks the real barrels and renders every declared state,
 *      asserting the registry's keys and the barrels' keys are the same set.
 *
 * WHAT "MANDATORY STATES" MEANS HERE: each component's OWN state contract from design-system §3
 * (Button: default/pressed/disabled/busy; PinPad: entry/error/locked; …). This is distinct from the
 * §5 mandatory SCREEN states (loading/empty/error/unauthorized) — those are satisfied by the
 * existence of the four state components, and are a screen's obligation, enforced at the screen
 * layer in tasks 24/25.
 */
import type { ReactNode } from 'react';
import { Text } from 'react-native';

import * as componentInventory from '../components/index.js';
import * as shellInventory from '../shell/index.js';
import { color, size } from '../tokens.js';

/** Every value exported by the two barrels. `export type` members are absent from `typeof`. */
export type InventoryName = keyof typeof componentInventory | keyof typeof shellInventory;

/**
 * Resolved, already-localized strings supplied by the host screen.
 *
 * `@bolusi/ui` never calls `t()` (08-stack §3.3: it may import `@bolusi/i18n` for KEY TYPES only),
 * so even the dev-only Gallery takes its copy as props. The Gallery's host resolves each of these
 * from the label catalog; the coverage test passes obvious placeholders.
 */
export interface GalleryLabels {
  readonly action: string;
  readonly cancel: string;
  readonly confirm: string;
  readonly back: string;
  readonly retry: string;
  readonly create: string;
  readonly title: string;
  readonly hint: string;
  readonly message: string;
  readonly fieldLabel: string;
  readonly fieldPlaceholder: string;
  readonly fieldError: string;
  readonly primaryText: string;
  readonly secondaryText: string;
  readonly errorCode: string;
  /** `sync.chip.pending` (07-i18n §3.1 key grammar; the KEY is the contract, this is its value). */
  readonly pendingChip: string;
  /** `sync.chip.rejected`. */
  readonly rejectedChip: string;
  readonly pinEntry: string;
  readonly pinBackspace: string;
  readonly pinError: string;
  readonly pinLocked: string;
  readonly syncChip: string;
  readonly avatarSwitch: string;
  readonly initials: string;
}

export interface GalleryState {
  /** Stable id, used as the Gallery section label and the coverage test's case name. */
  readonly id: string;
  readonly render: (labels: GalleryLabels) => ReactNode;
  /**
   * True for states that only exist DURING a touch (Button `pressed`). The Gallery shows them by
   * being pressable; the coverage test reaches them by firing `onPressIn`. Declaring it here keeps
   * the component free of any test-only prop.
   */
  readonly activatesOnPressIn?: boolean | undefined;
}

const noop = (): void => undefined;

const BUTTON_VARIANTS = ['primary', 'secondary', 'destructive'] as const;

/** §3.1: all four states are mandatory for ALL three variants — 12 entries, generated, not typed out. */
const buttonStates: readonly GalleryState[] = BUTTON_VARIANTS.flatMap((variant) => [
  {
    id: `${variant}.default`,
    render: (l: GalleryLabels) => (
      <componentInventory.Button
        testID="ui.button"
        label={l.action}
        onPress={noop}
        variant={variant}
      />
    ),
  },
  {
    id: `${variant}.pressed`,
    activatesOnPressIn: true,
    render: (l: GalleryLabels) => (
      <componentInventory.Button
        testID="ui.button"
        label={l.action}
        onPress={noop}
        variant={variant}
      />
    ),
  },
  {
    id: `${variant}.disabled`,
    render: (l: GalleryLabels) => (
      <componentInventory.Button
        testID="ui.button"
        label={l.action}
        onPress={noop}
        variant={variant}
        disabled
      />
    ),
  },
  {
    id: `${variant}.busy`,
    render: (l: GalleryLabels) => (
      <componentInventory.Button
        testID="ui.button"
        label={l.action}
        onPress={noop}
        variant={variant}
        busy
      />
    ),
  },
]);

export const stateRegistry: Record<InventoryName, readonly GalleryState[]> = {
  // ---- §3 components -------------------------------------------------------------------------
  Button: buttonStates,

  /**
   * §3.11 the signature. All three tiers side by side is the point: the Gallery is where a reviewer
   * checks that the fill difference reads at arm's length on a dimmed panel, which no test asserts.
   */
  FreshnessCell: (['fresh', 'warning', 'stale'] as const).map((level) => ({
    id: level,
    render: (l: GalleryLabels) => (
      <componentInventory.FreshnessCell level={level} accessibilityLabel={l.syncChip} />
    ),
  })),

  /** §3.12 — distinct ids so the Gallery shows that two people get two hues. */
  Avatar: [
    {
      id: 'row',
      render: (l) => <componentInventory.Avatar userId="u-1" initials={l.initials} size="row" />,
    },
    {
      id: 'header',
      render: (l) => <componentInventory.Avatar userId="u-2" initials={l.initials} size="header" />,
    },
    {
      id: 'switcher',
      render: (l) => (
        <componentInventory.Avatar userId="u-3" initials={l.initials} size="switcher" />
      ),
    },
  ],

  /** §3.13 — every §5 state plus `ready`; the union makes omitting one a compile error. */
  List: [
    {
      id: 'loading',
      render: () => (
        <componentInventory.List
          state={{ kind: 'loading' }}
          renderRow={() => <componentInventory.ListRow primaryText="" />}
          keyExtractor={() => ''}
        />
      ),
    },
    {
      id: 'empty',
      render: (l) => (
        <componentInventory.List
          state={{
            kind: 'empty',
            empty: { title: l.title, hint: l.hint, createLabel: l.create, onCreate: noop },
          }}
          renderRow={() => <componentInventory.ListRow primaryText="" />}
          keyExtractor={() => ''}
        />
      ),
    },
    {
      id: 'error',
      render: (l) => (
        <componentInventory.List
          state={{
            kind: 'error',
            error: { title: l.title, errorCode: l.errorCode, retryLabel: l.retry, onRetry: noop },
          }}
          renderRow={() => <componentInventory.ListRow primaryText="" />}
          keyExtractor={() => ''}
        />
      ),
    },
    {
      id: 'unauthorized',
      render: (l) => (
        <componentInventory.List
          state={{
            kind: 'unauthorized',
            unauthorized: { title: l.title, hint: l.hint, backLabel: l.back, onBack: noop },
          }}
          renderRow={() => <componentInventory.ListRow primaryText="" />}
          keyExtractor={() => ''}
        />
      ),
    },
    {
      id: 'ready',
      render: (l) => (
        <componentInventory.List
          state={{ kind: 'ready', items: ['a', 'b', 'c'] }}
          renderRow={(item) => (
            <componentInventory.ListRow
              testID={`ui.list.row.${item}`}
              primaryText={l.primaryText}
            />
          )}
          keyExtractor={(item) => item}
        />
      ),
    },
  ],

  TextInput: [
    {
      id: 'default',
      render: (l) => (
        <componentInventory.TextInput
          label={l.fieldLabel}
          value=""
          onChangeText={noop}
          placeholder={l.fieldPlaceholder}
        />
      ),
    },
    {
      id: 'focused',
      // `autoFocus` gives the Gallery a genuinely focused field on device; the focus ring itself is
      // asserted in the TextInput unit test by firing `onFocus`.
      render: (l) => (
        <componentInventory.TextInput
          label={l.fieldLabel}
          value={l.primaryText}
          onChangeText={noop}
          autoFocus
        />
      ),
    },
    {
      id: 'error',
      render: (l) => (
        <componentInventory.TextInput
          label={l.fieldLabel}
          value={l.primaryText}
          onChangeText={noop}
          errorMessage={l.fieldError}
        />
      ),
    },
    {
      id: 'disabled',
      render: (l) => (
        <componentInventory.TextInput
          label={l.fieldLabel}
          value={l.primaryText}
          onChangeText={noop}
          disabled
        />
      ),
    },
  ],

  PinPad: [
    {
      id: 'entry',
      render: (l) => (
        <componentInventory.PinPad
          onComplete={noop}
          entryLabel={l.pinEntry}
          backspaceLabel={l.pinBackspace}
        />
      ),
    },
    {
      id: 'error',
      render: (l) => (
        <componentInventory.PinPad
          onComplete={noop}
          state="error"
          message={l.pinError}
          entryLabel={l.pinEntry}
          backspaceLabel={l.pinBackspace}
        />
      ),
    },
    {
      id: 'locked',
      render: (l) => (
        <componentInventory.PinPad
          onComplete={noop}
          state="locked"
          message={l.pinLocked}
          entryLabel={l.pinEntry}
          backspaceLabel={l.pinBackspace}
        />
      ),
    },
  ],

  ListRow: [
    { id: 'static', render: (l) => <componentInventory.ListRow primaryText={l.primaryText} /> },
    {
      id: 'navigable',
      render: (l) => (
        <componentInventory.ListRow
          primaryText={l.primaryText}
          secondaryText={l.secondaryText}
          onPress={noop}
          showChevron
        />
      ),
    },
  ],

  Card: [
    {
      id: 'static',
      render: (l) => (
        <componentInventory.Card>
          <Text>{l.primaryText}</Text>
        </componentInventory.Card>
      ),
    },
    {
      id: 'tappable',
      render: (l) => (
        <componentInventory.Card onPress={noop} accessibilityLabel={l.action}>
          <Text>{l.primaryText}</Text>
        </componentInventory.Card>
      ),
    },
  ],

  Chip: [
    {
      id: 'neutral',
      render: (l) => <componentInventory.Chip label={l.pendingChip} icon="pending" />,
    },
    {
      id: 'warning',
      render: (l) => <componentInventory.Chip label={l.message} icon="warning" tone="warning" />,
    },
    {
      id: 'danger',
      render: (l) => (
        <componentInventory.Chip
          label={l.rejectedChip}
          icon="rejected"
          tone="danger"
          onPress={noop}
        />
      ),
    },
    {
      id: 'success',
      render: (l) => <componentInventory.Chip label={l.message} icon="success" tone="success" />,
    },
  ],

  /** §3.5 canonical sync chips. `synced` renders nothing — that IS the state. */
  SyncStatusChip: [
    {
      id: 'synced',
      render: (l) => (
        <componentInventory.SyncStatusChip
          syncStatuses={['synced']}
          pendingLabel={l.pendingChip}
          rejectedLabel={l.rejectedChip}
          onPressRejected={noop}
        />
      ),
    },
    {
      id: 'pending',
      render: (l) => (
        <componentInventory.SyncStatusChip
          syncStatuses={['local', 'synced']}
          pendingLabel={l.pendingChip}
          rejectedLabel={l.rejectedChip}
          onPressRejected={noop}
        />
      ),
    },
    {
      id: 'rejected',
      render: (l) => (
        <componentInventory.SyncStatusChip
          syncStatuses={['local', 'rejected']}
          pendingLabel={l.pendingChip}
          rejectedLabel={l.rejectedChip}
          onPressRejected={noop}
        />
      ),
    },
  ],

  Banner: [
    {
      id: 'info',
      render: (l) => (
        <componentInventory.Banner variant="info" message={l.message} onDismiss={noop} />
      ),
    },
    {
      id: 'warning',
      render: (l) => (
        <componentInventory.Banner
          variant="warning"
          message={l.message}
          onToggleCollapse={noop}
          actionLabel={l.action}
          onAction={noop}
        />
      ),
    },
    {
      id: 'warning.collapsed',
      render: (l) => (
        <componentInventory.Banner
          variant="warning"
          message={l.message}
          collapsed
          onToggleCollapse={noop}
        />
      ),
    },
    {
      id: 'danger',
      render: (l) => (
        <componentInventory.Banner
          variant="danger"
          message={l.message}
          onPress={noop}
          suppressedCount={2}
        />
      ),
    },
  ],

  Toast: [
    {
      id: 'neutral',
      render: (l) => <componentInventory.Toast message={l.message} onHide={noop} />,
    },
    {
      id: 'success',
      render: (l) => <componentInventory.Toast message={l.message} tone="success" onHide={noop} />,
    },
    {
      id: 'danger.withAction',
      render: (l) => (
        <componentInventory.Toast
          message={l.message}
          tone="danger"
          onHide={noop}
          actionLabel={l.action}
          onAction={noop}
        />
      ),
    },
  ],

  EmptyState: [
    { id: 'noCta', render: (l) => <componentInventory.EmptyState title={l.title} hint={l.hint} /> },
    {
      id: 'withCta',
      render: (l) => (
        <componentInventory.EmptyState
          title={l.title}
          hint={l.hint}
          createLabel={l.create}
          onCreate={noop}
        />
      ),
    },
  ],

  ErrorState: [
    {
      id: 'default',
      render: (l) => (
        <componentInventory.ErrorState
          title={l.title}
          hint={l.hint}
          errorCode={l.errorCode}
          retryLabel={l.retry}
          onRetry={noop}
        />
      ),
    },
  ],

  UnauthorizedState: [
    {
      id: 'default',
      render: (l) => (
        <componentInventory.UnauthorizedState
          title={l.title}
          hint={l.hint}
          backLabel={l.back}
          onBack={noop}
        />
      ),
    },
  ],

  LoadingState: [
    { id: 'skeleton', render: () => <componentInventory.LoadingState variant="skeleton" /> },
    { id: 'spinner', render: () => <componentInventory.LoadingState variant="spinner" /> },
  ],

  ConfirmSheet: [
    {
      id: 'default',
      render: (l) => (
        <componentInventory.ConfirmSheet
          title={l.title}
          message={l.message}
          confirmLabel={l.confirm}
          onConfirm={noop}
          cancelLabel={l.cancel}
          onCancel={noop}
        />
      ),
    },
  ],

  Icon: [
    {
      id: 'default',
      render: () => (
        <componentInventory.Icon name="info" size={size.iconInline} color={color.text} />
      ),
    },
  ],

  // ---- §8 shell ------------------------------------------------------------------------------
  /** §8.1 SyncChip — all five states; `offline` is neutral, only `attention` is danger (§4.6). */
  SyncChip: (['synced', 'pending', 'syncing', 'offline', 'attention'] as const).map((state) => ({
    id: state,
    render: (l: GalleryLabels) => (
      <shellInventory.SyncChip
        state={state}
        pendingCount={state === 'pending' ? 3 : undefined}
        accessibilityLabel={l.syncChip}
        onPress={noop}
      />
    ),
  })),

  AvatarButton: [
    {
      id: 'default',
      render: (l) => (
        <shellInventory.AvatarButton
          userId="u-2"
          initials={l.initials}
          accessibilityLabel={l.avatarSwitch}
          onPress={noop}
        />
      ),
    },
  ],

  AppShell: [
    {
      id: 'root',
      render: (l) => (
        <shellInventory.AppShell
          title={l.title}
          syncChip={
            <shellInventory.SyncChip
              state="synced"
              accessibilityLabel={l.syncChip}
              onPress={noop}
            />
          }
          avatar={
            <shellInventory.AvatarButton
              userId="u-2"
              initials={l.initials}
              accessibilityLabel={l.avatarSwitch}
              onPress={noop}
            />
          }
        >
          {null}
        </shellInventory.AppShell>
      ),
    },
    {
      id: 'detail.withBannerAndAction',
      render: (l) => (
        <shellInventory.AppShell
          title={l.title}
          titleVariant="detail"
          onBack={noop}
          backLabel={l.back}
          syncChip={
            <shellInventory.SyncChip
              state="attention"
              accessibilityLabel={l.syncChip}
              onPress={noop}
            />
          }
          avatar={
            <shellInventory.AvatarButton
              userId="u-2"
              initials={l.initials}
              accessibilityLabel={l.avatarSwitch}
              onPress={noop}
            />
          }
          banner={<componentInventory.Banner variant="danger" message={l.message} onPress={noop} />}
          bottomAction={<componentInventory.Button label={l.action} onPress={noop} />}
        >
          {null}
        </shellInventory.AppShell>
      ),
    },
  ],
};
