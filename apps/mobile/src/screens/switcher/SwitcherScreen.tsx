/**
 * User Switcher (design-system §8.2) — also the idle-lock screen.
 *
 * Renders `model.ts`'s state; every decision worth explaining lives there. Two things are visible
 * only here:
 *
 *  - THE LOCK HAS NO BACK and says `auth.switcher.idleLocked` — "Layar terkunci karena lama tidak
 *    dipakai. Pekerjaanmu aman." The second sentence is the whole reason the lock is tolerable
 *    (SEC-AUTH-08): the first thing a technician wants to know when the screen locks mid-repair is
 *    whether they just lost the note they were typing. Answering it on the lock screen, before they
 *    ask, is what stops the shop from raising `idleLockSeconds` to its ceiling.
 *
 *  - The grid rides `List` via `toGridRows` (see model.ts) — virtualized, because a shop with 30
 *    staff must not mount 30 avatars.
 */
import { t } from '@bolusi/i18n';
import {
  AppShell,
  Avatar,
  Banner,
  List,
  SyncChip,
  color,
  space,
  touch,
  type,
  type ListState,
  type SyncChipState,
} from '@bolusi/ui';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { SwitcherMode } from '../../navigation/zone.js';

import {
  initialsOf,
  SWITCHER_EMPTY_HINT_KEY,
  SWITCHER_LOCK_KEY,
  toGridRows,
  type SwitcherGridRow,
  type SwitcherState,
  type SwitcherUser,
} from './model.js';

export interface SwitcherScreenProps {
  readonly state: SwitcherState;
  readonly mode: SwitcherMode;
  /** Null when acting as the lock — §8.2: no header back (it would walk into the last session). */
  readonly onBack: (() => void) | null;
  readonly onSelect: (user: SwitcherUser) => void;
  /**
   * §5's Error retry: re-run the directory read that failed. RE-RUN, not "go away" — see
   * `onUnauthorizedBack` for why the distinction is a prop and not a comment.
   */
  readonly onRetry: () => void;
  /**
   * §5's Unauthorized back.
   *
   * A SEPARATE PROP FROM `onRetry`, which is the whole point (task 130). Both arms used to be handed
   * the same `onRetry`, so "coba lagi" on the error state and "kembali" on the unauthorized state
   * were literally one function — two different user intents behind one callback, and the composition
   * root passed `noop` for it, so both dead-ended. A single prop cannot be half-wired: whatever it
   * gets, one of the two arms is doing the wrong thing. Splitting it makes the wrong wiring a
   * compile-visible fact rather than a behaviour nobody can see.
   */
  readonly onUnauthorizedBack: () => void;
  readonly syncChip: SyncChipState;
  readonly onOpenSync: () => void;
}

export function SwitcherScreen({
  state,
  mode,
  onBack,
  onSelect,
  onRetry,
  onUnauthorizedBack,
  syncChip,
  onOpenSync,
}: SwitcherScreenProps): React.JSX.Element {
  const listState: ListState<SwitcherGridRow> =
    state.kind === 'loading'
      ? { kind: 'loading' }
      : state.kind === 'empty'
        ? {
            kind: 'empty',
            empty: {
              title: t('core.status.empty'),
              // GUIDANCE, NOT A BUTTON (owner ruling D23 §3 — see `SWITCHER_EMPTY_HINT_KEY`). No
              // `createLabel`/`onCreate`: `EmptyState` renders its CTA IFF `onCreate` is supplied
              // (EmptyState.tsx:20-27), so omitting them is the whole removal — the affordance
              // cannot come back by accident, because there is no handler for it to come back to.
              // The previous hint here was `auth.enroll.instruction`, the WIZARD's copy ("Masuk
              // dengan akun kamu…"), which addressed a login form this screen does not have.
              hint: t(SWITCHER_EMPTY_HINT_KEY),
              testID: 'switcher-empty',
            },
          }
        : state.kind === 'error'
          ? {
              kind: 'error',
              error: {
                title: t('core.errors.UNEXPECTED'),
                errorCode: state.code,
                retryLabel: t('core.action.retry'),
                onRetry,
                testID: 'switcher-error',
              },
            }
          : state.kind === 'unauthorized'
            ? {
                kind: 'unauthorized',
                unauthorized: {
                  title: t('core.errors.PERMISSION_DENIED'),
                  backLabel: t('core.action.back'),
                  onBack: onUnauthorizedBack,
                  testID: 'switcher-unauthorized',
                },
              }
            : { kind: 'ready', items: toGridRows(state.users) };

  return (
    <AppShell
      title={t('auth.switcher.title')}
      {...(onBack !== null ? { onBack, backLabel: t('core.action.back') } : {})}
      syncChip={
        <SyncChip
          state={syncChip}
          accessibilityLabel={t('sync.status.lastSynced', { relative: '' })}
          onPress={onOpenSync}
        />
      }
      avatar={<View testID="switcher-no-avatar" />}
      banner={
        mode === 'lock' ? (
          <Banner variant="info" message={t(SWITCHER_LOCK_KEY)} testID="switcher-lock-banner" />
        ) : undefined
      }
      testID="switcher-screen"
    >
      <Text style={styles.instruction} testID="switcher-instruction">
        {t('auth.switcher.instruction')}
      </Text>
      <List
        state={listState}
        keyExtractor={(row) => row.key}
        renderRow={(row) => <GridRow row={row} onSelect={onSelect} />}
        testID="switcher-list"
      />
    </AppShell>
  );
}

/** One grid row — up to two cards, then a spacer so an odd count leaves a gap, not a ghost. */
function GridRow({
  row,
  onSelect,
}: {
  readonly row: SwitcherGridRow;
  readonly onSelect: (user: SwitcherUser) => void;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      {row.users.map((user) => (
        <UserCard key={user.id} user={user} onSelect={onSelect} />
      ))}
      {row.users.length === 1 ? <View style={styles.cardSlot} testID="switcher-spacer" /> : null}
    </View>
  );
}

function UserCard({
  user,
  onSelect,
}: {
  readonly user: SwitcherUser;
  readonly onSelect: (user: SwitcherUser) => void;
}): React.JSX.Element {
  return (
    <Pressable
      style={styles.cardSlot}
      onPress={() => onSelect(user)}
      accessibilityRole="button"
      accessibilityLabel={user.name}
      testID={`switcher-user-${user.id}`}
      android_ripple={RIPPLE}
    >
      <View style={styles.card}>
        <Avatar userId={user.id} initials={initialsOf(user.name)} size="switcher" />
        <Text style={styles.name} numberOfLines={2} testID={`switcher-user-name-${user.id}`}>
          {user.name}
        </Text>
      </View>
    </Pressable>
  );
}

const RIPPLE = { color: color.surfaceAlt } as const;

const styles = StyleSheet.create({
  instruction: {
    ...type.bodySm,
    color: color.textMuted,
    marginBottom: space.lg,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    gap: space.md,
  },
  cardSlot: {
    flex: 1,
  },
  card: {
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.lg,
    minHeight: touch.row,
  },
  name: {
    ...type.body,
    color: color.text,
    textAlign: 'center',
  },
});
