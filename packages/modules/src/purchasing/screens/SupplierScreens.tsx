/**
 * SupplierList — the business's suppliers (one list for every store), and SupplierForm to add or
 * change one: a name and the WhatsApp number orders are sent to. A supplier taken off the list keeps
 * its orders; it is just not offered for new ones.
 */
import { formatPhone, t } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  ListRow,
  TextButton,
  TextInput,
  ToggleChip,
  ChipRow,
  color,
  space,
  type,
  Text,
} from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useActionRunner } from '../../screen-kit/index.js';
import { FlowScreen, QueryView, type ScreenChrome } from '../../screen-kit/screens/views.js';
import { MAX_PURCHASING_NOTE, MAX_SUPPLIER_NAME, MAX_SUPPLIER_PHONE } from '../constants.js';
import { tp } from '../i18n.js';
import type { SupplierRow } from '../queries.js';
import { usePurchasingQuery, usePurchasingRuntime } from '../runtime.js';

export interface SupplierListProps {
  readonly chrome: ScreenChrome;
  readonly onBack: () => void;
  readonly onOpen: (supplier: SupplierRow) => void;
  readonly onAdd: () => void;
  readonly notice: string | null;
  readonly onClearNotice: () => void;
  readonly testID?: string | undefined;
}

export function SupplierList({
  chrome,
  onBack,
  onOpen,
  onAdd,
  notice,
  onClearNotice,
  testID = 'purchasing.suppliers',
}: SupplierListProps): React.JSX.Element {
  const [archived, setArchived] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = usePurchasingQuery(
    async (rt) =>
      (await rt.query('listSuppliers', { includeArchived: archived })).rows.filter(
        (row) => row.archived === archived,
      ),
    `supplierList:${String(archived)}:${String(reloadNonce)}`,
  );
  return (
    <AppShell
      scrollable
      title={tp('purchasing.supplier.listTitle')}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      banner={
        notice === null ? undefined : (
          <Banner
            variant="info"
            message={notice}
            onPress={onClearNotice}
            testID={`${testID}.notice`}
          />
        )
      }
      bottomAction={
        <Button label={tp('purchasing.supplier.add')} onPress={onAdd} testID={`${testID}.add`} />
      }
      testID={testID}
    >
      <View style={styles.chips}>
        <ChipRow testID={`${testID}.chips`}>
          <ToggleChip
            label={tp('purchasing.supplier.active')}
            selected={!archived}
            onToggle={() => setArchived(false)}
            testID={`${testID}.active`}
          />
          <ToggleChip
            label={tp('purchasing.supplier.archived')}
            selected={archived}
            onToggle={() => setArchived(true)}
            testID={`${testID}.archived`}
          />
        </ChipRow>
      </View>
      <QueryView
        query={query}
        onBack={onBack}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={testID}
      >
        {(rows) =>
          rows.length === 0 ? (
            <Text style={styles.muted}>
              {tp(archived ? 'purchasing.supplier.noArchived' : 'purchasing.supplier.empty')}
            </Text>
          ) : (
            <View style={styles.bleed}>
              {rows.map((row) => (
                <ListRow
                  key={row.id}
                  primaryText={row.name}
                  secondaryText={row.phone === null ? undefined : formatPhone(row.phone)}
                  onPress={() => onOpen(row)}
                  showChevron
                  testID={`${testID}.row.${row.id}`}
                />
              ))}
            </View>
          )
        }
      </QueryView>
    </AppShell>
  );
}

export interface SupplierFormProps {
  readonly chrome: ScreenChrome;
  readonly supplier?: SupplierRow | undefined;
  readonly onDone: (supplierId: string) => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

export function SupplierForm({
  chrome,
  supplier,
  onDone,
  onCancel,
  testID = 'purchasing.supplierForm',
}: SupplierFormProps): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const [name, setName] = useState(supplier?.name ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [note, setNote] = useState(supplier?.note ?? '');
  const details = { name: name.trim(), phone: phone.trim() || null, note: note.trim() || null };
  const unchanged =
    supplier !== undefined &&
    details.name === supplier.name &&
    details.phone === supplier.phone &&
    details.note === supplier.note;

  const save = (archived: boolean): void => {
    void runner
      .run(async () =>
        supplier === undefined
          ? (await runtime.run('addSupplier', details)).supplierId
          : (await runtime.run('editSupplier', { supplierId: supplier.id, archived, ...details }))
              .supplierId,
      )
      .then((supplierId) => {
        if (supplierId !== undefined) onDone(supplierId);
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tp(
        supplier === undefined ? 'purchasing.supplier.add' : 'purchasing.supplier.editTitle',
      )}
      onBack={onCancel}
      primaryLabel={tp('purchasing.supplier.save')}
      onPrimary={() => save(supplier?.archived ?? false)}
      primaryDisabled={details.name === '' || unchanged}
      primaryHint={unchanged ? undefined : tp('purchasing.supplier.nameFirst')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <View style={styles.fields}>
        <TextInput
          label={tp('purchasing.supplier.name')}
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          maxLength={MAX_SUPPLIER_NAME}
          testID={`${testID}.name`}
        />
        <TextInput
          label={tp('purchasing.supplier.phone')}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          maxLength={MAX_SUPPLIER_PHONE}
          testID={`${testID}.phone`}
        />
        <TextInput
          label={tp('purchasing.supplier.note')}
          value={note}
          onChangeText={setNote}
          multiline
          maxLength={MAX_PURCHASING_NOTE}
          testID={`${testID}.note`}
        />
      </View>
      {supplier === undefined ? null : (
        <View style={styles.archive}>
          <TextButton
            label={tp(
              supplier.archived ? 'purchasing.supplier.restore' : 'purchasing.supplier.archive',
            )}
            tone={supplier.archived ? 'primary' : 'danger'}
            onPress={() => save(!supplier.archived)}
            disabled={runner.busy}
            testID={`${testID}.archive`}
          />
        </View>
      )}
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  chips: { marginBottom: space.sm },
  muted: { ...type.bodySm, color: color.textMuted },
  bleed: { marginHorizontal: -space.lg },
  fields: { gap: space.lg },
  archive: { marginTop: space['2xl'], alignItems: 'flex-start', marginLeft: -space.sm },
});
