/**
 * NotesList (design-system §8.6) — the first module list screen, and the pattern every later one
 * copies. All four §5 states, a live-updating `listNotes` (04 §7), per-row sync chip (§3.5) and
 * media-attachment glyph (§8.6), and an "unauthorized ≠ empty" exit that is the reference proof of
 * FR-1036: a denied read renders the Unauthorized state, never an empty list.
 *
 * Nothing here touches the DB or the op log — it reads through `useQuery` and writes through the
 * navigation callbacks its container wires (04 §7). The header sync chip + avatar are shell chrome
 * (task 24), passed in as slots exactly as `AppShell` takes them.
 */
import { formatRelative, t, translateErrorCode } from '@bolusi/i18n';
import {
  AppShell,
  Button,
  Icon,
  List,
  ListRow,
  SyncStatusChip,
  color,
  size,
  space,
  type,
  type ListState,
} from '@bolusi/ui';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { NOTES_PERMISSION } from '../constants.js';
import type { NoteRow } from '../queries.js';

import { tn } from './i18n.js';
import { bodyPreview, statusesFor } from './model.js';
import { useNotesRuntime, useQuery, type NoteSyncStatuses } from './runtime.js';

/** First page size; 04 §6 caps `limit` at 100 and §3.13's List is windowed regardless. */
const PAGE = 50;
const MAX_PAGE = 100;

export interface NotesListProps {
  /** ms epoch, for relative timestamps (07-i18n §5.3 — never raw device arithmetic in the view). */
  readonly now: number;
  /** Shell chrome (task 24): the always-present header sync chip + avatar (§8.1). */
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onOpenNote: (noteId: string) => void;
  readonly onCreateNote: () => void;
  /** A rejected sync chip is always tappable → the Sync Status screen (§3.5, §8.4). */
  readonly onOpenSyncStatus: () => void;
  readonly testID?: string | undefined;
}

interface LoadedList {
  readonly rows: readonly NoteRow[];
  readonly statuses: NoteSyncStatuses;
  readonly hasMore: boolean;
}

export function NotesList({
  now,
  syncChip,
  avatar,
  onOpenNote,
  onCreateNote,
  onOpenSyncStatus,
  testID = 'notes.list',
}: NotesListProps): React.JSX.Element {
  const runtime = useNotesRuntime();
  const [showArchived, setShowArchived] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  // Bumped by retry so the query re-runs even when nothing else changed (setState bails on equality).
  const [reloadNonce, setReloadNonce] = useState(0);

  // ONE live query (04 §7): the page AND its per-row op statuses, so a pulled remote op re-renders
  // both the row and its chip in place. The filter/limit/nonce form the dependency identity.
  const query = useQuery<LoadedList>(
    async (rt) => {
      const page = await rt.listNotes({
        filter: { archived: showArchived },
        sort: 'createdAt.desc',
        limit,
      });
      const statuses = await rt.noteSyncStatuses(page.rows.map((row) => row.id));
      return { rows: page.rows, statuses, hasMore: page.nextCursor !== null };
    },
    `list:${String(showArchived)}:${String(limit)}:${String(reloadNonce)}`,
  );

  // The create-CTA is gated on the create permission, not the read (design-system §5/§8.6). The
  // query layer is still the enforcement truth; this only decides whether the CTA shows.
  const canCreate = runtime.hasPermission(NOTES_PERMISSION.create);

  const listState = ((): ListState<NoteRow> => {
    switch (query.status) {
      case 'loading':
        return { kind: 'loading' };
      case 'unauthorized':
        // FR-1036: a denied read is NEVER an empty list. The reference "unauthorized ≠ empty".
        return {
          kind: 'unauthorized',
          unauthorized: {
            title: t('core.errors.PERMISSION_DENIED'),
            backLabel: t('core.action.back'),
            onBack: onOpenSyncStatus,
          },
        };
      case 'error':
        return {
          kind: 'error',
          error: {
            title: translateErrorCode(query.code),
            errorCode: query.code,
            retryLabel: t('core.action.retry'),
            onRetry: () => setReloadNonce((current) => current + 1),
          },
        };
      case 'ready':
        if (query.data.rows.length === 0) {
          return {
            kind: 'empty',
            empty: {
              title: t('core.status.empty'),
              hint: tn('notes.list.empty'),
              // CTA present ⇔ the user holds `notes.create`. Absent otherwise — the falsified gate.
              ...(canCreate ? { createLabel: tn('notes.action.new'), onCreate: onCreateNote } : {}),
            },
          };
        }
        return { kind: 'ready', items: query.data.rows };
    }
  })();

  const loaded = query.status === 'ready' ? query.data : null;

  return (
    <AppShell
      title={tn('notes.list.title')}
      titleVariant="root"
      syncChip={syncChip}
      avatar={avatar}
      bottomAction={
        // The one primary action of the screen (§0, §8.1), in the thumb zone — shown only when the
        // user can create (mirrors the empty-state CTA gate).
        canCreate ? (
          <Button
            label={tn('notes.action.new')}
            onPress={onCreateNote}
            testID={`${testID}.create`}
          />
        ) : undefined
      }
      testID={testID}
    >
      <View style={styles.toolbar}>
        <Button
          label={tn('notes.filter.showArchived')}
          variant={showArchived ? 'primary' : 'secondary'}
          onPress={() => setShowArchived((current) => !current)}
          testID={`${testID}.archivedToggle`}
        />
      </View>

      <List
        state={listState}
        keyExtractor={(row) => row.id}
        onEndReached={
          loaded?.hasMore === true && limit < MAX_PAGE
            ? () => setLimit((current) => Math.min(current + PAGE, MAX_PAGE))
            : undefined
        }
        renderRow={(row) => (
          <ListRow
            primaryText={row.title}
            secondaryText={secondaryFor(row, now)}
            leading={
              row.mediaId === null ? undefined : (
                <Icon
                  name="attachment"
                  size={size.iconInline}
                  color={color.textMuted}
                  testID={`${testID}.attach.${row.id}`}
                />
              )
            }
            trailing={
              <SyncStatusChip
                syncStatuses={statusesFor(loaded?.statuses ?? {}, row.id)}
                pendingLabel={t('sync.chip.pending')}
                rejectedLabel={t('sync.chip.rejected')}
                onPressRejected={onOpenSyncStatus}
                testID={`${testID}.sync.${row.id}`}
              />
            }
            onPress={() => onOpenNote(row.id)}
            showChevron
            testID={`${testID}.row.${row.id}`}
          />
        )}
        testID={`${testID}.items`}
      />

      {showArchived ? (
        <Text style={styles.archivedHint} testID={`${testID}.archivedActive`}>
          {tn('notes.badge.archived')}
        </Text>
      ) : null}
    </AppShell>
  );
}

/** Row secondary line: a one-line body preview, or the created time when the body is empty (§3.4). */
function secondaryFor(row: NoteRow, now: number): string {
  const preview = bodyPreview(row.body);
  return preview.length === 0 ? formatRelative(now - row.createdAt) : preview;
}

const styles = StyleSheet.create({
  toolbar: { marginBottom: space.md },
  archivedHint: {
    ...type.caption,
    color: color.textMuted,
    marginTop: space.sm,
    textAlign: 'center',
  },
});
