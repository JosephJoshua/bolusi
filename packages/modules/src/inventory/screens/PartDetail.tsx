/**
 * PartDetail — one part: what this store has, what it is and fits, and every movement here (counts,
 * takes and put-backs, with who and for which servisan). Owners count it, edit it, or take it off
 * the list; the history stays either way.
 */
import { formatDateTime, t } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  Card,
  Chip,
  ConfirmSheet,
  Fact,
  FactGrid,
  TextButton,
  Timeline,
  color,
  space,
  type,
} from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useActionRunner } from '../../screen-kit/index.js';
import {
  ActionErrorBanner,
  QueryView,
  Section,
  type ScreenChrome,
} from '../../screen-kit/screens/views.js';
import { INVENTORY_PERMISSION } from '../constants.js';
import { ti, type InventoryKey } from '../i18n.js';
import { movementTitle, signedQty, stockText } from '../labels.js';
import type { PartDetailRow, PartRow } from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';

export interface PartDetailProps {
  readonly partId: string;
  readonly chrome: ScreenChrome;
  readonly onBack: () => void;
  readonly onEdit: (part: PartRow) => void;
  readonly onCount: (part: PartRow) => void;
  /** What the last step did ("Jumlah stok disimpan."), shown until dismissed. */
  readonly notice: InventoryKey | null;
  readonly onClearNotice: () => void;
  readonly testID?: string | undefined;
}

export function PartDetail({
  partId,
  chrome,
  onBack,
  onEdit,
  onCount,
  notice,
  onClearNotice,
  testID = 'inventory.part',
}: PartDetailProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const canManage = runtime.hasPermission(INVENTORY_PERMISSION.manageParts);
  const canCount = runtime.hasPermission(INVENTORY_PERMISSION.count);
  const runner = useActionRunner();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [done, setDone] = useState<InventoryKey | null>(null);

  const query = useInventoryQuery(
    async (rt) => (await rt.query('getPart', { partId })).rows[0],
    `part:${partId}:${String(reloadNonce)}`,
  );
  const part = query.status === 'ready' ? query.data : undefined;
  const shownNotice = done ?? notice;

  const setArchived = (row: PartDetailRow, archived: boolean): void => {
    setConfirmArchive(false);
    onClearNotice();
    setDone(null);
    void runner
      .run(() =>
        runtime.run('editPart', {
          partId: row.id,
          name: row.name,
          code: row.code,
          fits: row.fits,
          archived,
        }),
      )
      .then((result) => {
        if (result !== undefined)
          setDone(archived ? 'inventory.done.archived' : 'inventory.done.restored');
      });
  };

  return (
    <AppShell
      scrollable
      title={part?.name ?? ti('inventory.list.title')}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      banner={
        runner.errorCode !== null ? (
          <ActionErrorBanner
            errorCode={runner.errorCode}
            onDismiss={runner.clearError}
            testID={`${testID}.error`}
          />
        ) : shownNotice !== null ? (
          <Banner
            variant="info"
            message={ti(shownNotice)}
            onPress={() => {
              setDone(null);
              onClearNotice();
            }}
            testID={`${testID}.notice`}
          />
        ) : undefined
      }
      bottomAction={
        canCount && part !== undefined && !part.archived ? (
          <Button
            label={ti('inventory.action.count')}
            onPress={() => onCount(part)}
            testID={`${testID}.count`}
          />
        ) : undefined
      }
      overlay={
        confirmArchive && part !== undefined ? (
          <ConfirmSheet
            title={ti('inventory.archive.title')}
            message={ti('inventory.archive.message')}
            confirmLabel={ti('inventory.action.archive')}
            onConfirm={() => setArchived(part, true)}
            cancelLabel={t('core.action.cancel')}
            onCancel={() => setConfirmArchive(false)}
            testID={`${testID}.archiveConfirm`}
          />
        ) : undefined
      }
      testID={testID}
    >
      <QueryView
        query={query}
        onBack={onBack}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={testID}
      >
        {(row) => (row === undefined ? null : renderPart(row))}
      </QueryView>
    </AppShell>
  );

  function renderPart(row: PartDetailRow): React.JSX.Element {
    const below = row.onHand < 0;
    return (
      <View testID={`${testID}.content`}>
        <Card testID={`${testID}.summary`}>
          <Text style={styles.stockLabel}>{ti('inventory.detail.stockHere')}</Text>
          <Text style={[styles.stock, below ? styles.below : null]} testID={`${testID}.stock`}>
            {stockText(row.onHand)}
          </Text>
          {below || row.archived ? (
            <View style={styles.chips}>
              {below ? (
                <Chip label={ti('inventory.list.belowZero')} icon="warning" tone="warning" />
              ) : null}
              {row.archived ? (
                <Chip label={ti('inventory.list.archived')} icon="pending" tone="neutral" />
              ) : null}
            </View>
          ) : null}
        </Card>

        {row.code === null && row.fits === null && !canManage ? null : (
          <Section
            title={ti('inventory.detail.title')}
            action={
              canManage ? (
                <TextButton
                  label={ti('inventory.action.edit')}
                  onPress={() => onEdit(row)}
                  disabled={runner.busy}
                  testID={`${testID}.edit`}
                />
              ) : undefined
            }
          >
            <FactGrid>
              <Fact
                label={ti('inventory.detail.code')}
                value={row.code ?? '–'}
                testID={`${testID}.code`}
              />
              <Fact
                label={ti('inventory.detail.fits')}
                value={row.fits ?? '–'}
                wide
                testID={`${testID}.fits`}
              />
            </FactGrid>
          </Section>
        )}

        <Section title={ti('inventory.detail.history')} testID={`${testID}.history`}>
          {row.movements.length === 0 ? (
            <Text style={styles.muted}>{ti('inventory.detail.noHistory')}</Text>
          ) : (
            <Timeline
              entries={row.movements.map((movement) => ({
                key: movement.id,
                title: `${movementTitle(movement)} · ${signedQty(movement.qty)}`,
                meta: [formatDateTime(movement.at), movement.userName]
                  .filter((part) => part !== null)
                  .join(' · '),
                ...(movement.note === null ? {} : { detail: movement.note }),
              }))}
              testID={`${testID}.timeline`}
            />
          )}
        </Section>

        {canManage ? (
          <View style={styles.archive}>
            {row.archived ? (
              <TextButton
                label={ti('inventory.action.restore')}
                onPress={() => setArchived(row, false)}
                disabled={runner.busy}
                testID={`${testID}.restore`}
              />
            ) : (
              <TextButton
                label={ti('inventory.action.archive')}
                tone="danger"
                onPress={() => setConfirmArchive(true)}
                disabled={runner.busy}
                testID={`${testID}.archive`}
              />
            )}
          </View>
        ) : null}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  stockLabel: { ...type.caption, color: color.textMuted },
  stock: { ...type.display, color: color.text, fontVariant: ['tabular-nums'], marginTop: space.xs },
  below: { color: color.danger },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  muted: { ...type.bodySm, color: color.textMuted },
  archive: { marginTop: space['2xl'], alignItems: 'flex-start', marginLeft: -space.sm },
});
