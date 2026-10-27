/**
 * The six intake steps the wizard walks through (IntakeWizard.tsx): each edits its part of the one
 * draft through `update` and shows the problems the wizard hands it.
 */
import { formatMoney, formatNumber, formatPhone, t } from '@bolusi/i18n';
import {
  Button,
  Card,
  ListRow,
  PhotoSlot,
  SegmentedControl,
  TextButton,
  TextInput,
  ToggleChip,
  border,
  color,
  space,
  type,
} from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { CHECKLIST_STATES } from '../constants.js';

import { tn } from '../i18n.js';
import {
  CHECK_STATE_KEY,
  INTAKE_STEP_KEY,
  PRICE_KIND_KEY,
  optionLabel,
  readyLabel,
} from '../labels.js';
import {
  INTAKE_STEPS,
  capturedThumbnailRef,
  checksWithIssue,
  chosenAccessories,
  chosenReady,
  intakeDownPayment,
  intakeTotal,
  acceptsRupiahText,
  parseRupiah,
  restOfChecksOk,
  signedAmount,
  type IntakeDraft,
  type IntakeStep,
  type QuoteLineDraft,
} from '../flows.js';
import type { IntakeOption, IntakeOptionLists } from '../intake-options.js';
import { DownPaymentRows, Field, PhotoGrid, PhotoThumb, Section, repairStyles } from './parts.js';
import { useRepairQuery } from '../runtime.js';
import { usePriceKinds, type PriceKind } from './TicketSteps.js';

export interface StepProps {
  readonly draft: IntakeDraft;
  readonly update: (patch: Partial<IntakeDraft>) => void;
  /** The lists this store offers (the owner's, without what the store hides). */
  readonly options: IntakeOptionLists;
  readonly testID: string;
}

/**
 * A new customer by name and phone, with existing customers whose name or phone fuzzily match
 * offered as the user types, so a returning customer is picked instead of entered twice.
 */
export function CustomerStep({
  draft,
  update,
  nameError,
  testID,
}: StepProps & { readonly nameError: string | undefined }): React.JSX.Element {
  const customer = draft.customer;
  const searchText =
    customer.kind === 'new' ? [customer.name, customer.phone].join(' ').trim() : '';
  const matches = useRepairQuery(
    async (rt) =>
      searchText.length < 2
        ? []
        : (await rt.query('searchCustomers', { text: searchText, limit: 5 })).rows,
    `customers:${searchText}`,
  );

  if (customer.kind === 'existing') {
    return (
      <Card testID={`${testID}.picked`}>
        <Text style={repairStyles.heading}>{customer.name}</Text>
        {customer.phone === null ? null : (
          <Text style={repairStyles.muted}>{formatPhone(customer.phone)}</Text>
        )}
        <View style={repairStyles.gap}>
          <Button
            label={tn('repair.customer.change')}
            variant="secondary"
            onPress={() => update({ customer: { kind: 'new', name: '', phone: '' } })}
            testID={`${testID}.change`}
          />
        </View>
      </Card>
    );
  }

  return (
    <View>
      <TextInput
        label={tn('repair.customer.name')}
        value={customer.name}
        onChangeText={(name) => update({ customer: { ...customer, name } })}
        errorMessage={nameError}
        autoFocus
        testID={`${testID}.name`}
      />
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.customer.phone')}
          placeholder={tn('repair.customer.phoneHint')}
          value={customer.phone}
          onChangeText={(phone) => update({ customer: { ...customer, phone } })}
          keyboardType="phone-pad"
          testID={`${testID}.phone`}
        />
      </View>
      {matches.status === 'ready' && matches.data.length > 0 ? (
        <Section title={tn('repair.customer.existing')} testID={`${testID}.matches`}>
          {matches.data.map((row) => (
            <ListRow
              key={row.id}
              primaryText={row.name}
              secondaryText={row.phone === null ? undefined : formatPhone(row.phone)}
              onPress={() =>
                update({
                  customer: {
                    kind: 'existing',
                    customerId: row.id,
                    name: row.name,
                    phone: row.phone,
                  },
                })
              }
              testID={`${testID}.match.${row.id}`}
            />
          ))}
        </Section>
      ) : null}
    </View>
  );
}

export function DeviceStep({
  draft,
  update,
  options,
  brandError,
  modelError,
  testID,
}: StepProps & {
  readonly brandError: string | undefined;
  readonly modelError: string | undefined;
}): React.JSX.Element {
  const device = draft.device;
  const [passcodeShown, setPasscodeShown] = useState(false);
  const set = (patch: Partial<IntakeDraft['device']>): void =>
    update({ device: { ...device, ...patch } });
  return (
    <View>
      <TextInput
        label={tn('repair.device.brand')}
        value={device.brand}
        onChangeText={(brand) => set({ brand })}
        errorMessage={brandError}
        autoFocus
        testID={`${testID}.brand`}
      />
      <View style={[styles.chips, styles.suggestions]}>
        {options.brands.map((option) => {
          const brand = optionLabel('brands', option);
          return (
            <ToggleChip
              key={option.id}
              label={brand}
              selected={device.brand === brand}
              onToggle={() => set({ brand })}
              testID={`${testID}.brandChoice.${brand}`}
            />
          );
        })}
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.device.model')}
          value={device.model}
          onChangeText={(model) => set({ model })}
          errorMessage={modelError}
          testID={`${testID}.model`}
        />
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.device.colorField')}
          value={device.color}
          onChangeText={(color) => set({ color })}
          testID={`${testID}.color`}
        />
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.device.imeiField')}
          value={device.imei}
          onChangeText={(imei) => set({ imei })}
          keyboardType="number-pad"
          testID={`${testID}.imei`}
        />
      </View>
      <View style={repairStyles.gap}>
        {/* Hidden while typed, so it is not read over the counter; shown on request to check it. */}
        <TextInput
          label={tn('repair.device.passcode')}
          value={device.passcode}
          onChangeText={(passcode) => set({ passcode })}
          secureTextEntry={!passcodeShown}
          testID={`${testID}.passcode`}
        />
        <View style={[styles.chips, styles.suggestions]}>
          <ToggleChip
            label={tn('repair.passcode.show')}
            selected={passcodeShown}
            onToggle={() => setPasscodeShown((shown) => !shown)}
            testID={`${testID}.passcode.show`}
          />
        </View>
      </View>
    </View>
  );
}

export function ConditionStep({
  draft,
  update,
  options,
  complaintError,
  testID,
}: StepProps & { readonly complaintError: string | undefined }): React.JSX.Element {
  const togglePeripheral = (item: string): void =>
    update({
      peripherals: draft.peripherals.includes(item)
        ? draft.peripherals.filter((p) => p !== item)
        : [...draft.peripherals, item],
    });
  return (
    <View>
      <TextInput
        label={tn('repair.condition.complaint')}
        value={draft.complaint}
        onChangeText={(complaint) => update({ complaint })}
        errorMessage={complaintError}
        multiline
        autoFocus
        testID={`${testID}.complaint`}
      />
      {options.checks.length === 0 ? null : (
        <Section
          title={tn('repair.condition.checks')}
          action={
            <TextButton
              label={tn('repair.condition.restOk')}
              icon="check"
              onPress={() => update({ checks: restOfChecksOk(draft.checks, options.checks) })}
              testID={`${testID}.restOk`}
            />
          }
        >
          {options.checks.map((option, index) => (
            // One line per check: the name on the left (wrapping if long), its state lined up on the
            // right, so the column of choices reads straight down.
            <View key={option.id} style={[styles.check, index === 0 ? null : styles.checkDivider]}>
              <Text style={styles.checkLabel}>{optionLabel('checks', option)}</Text>
              <SegmentedControl
                options={CHECKLIST_STATES.map((value) => ({
                  value,
                  label: tn(CHECK_STATE_KEY[value]),
                }))}
                value={draft.checks[option.id] ?? 'not_checked'}
                onChange={(state) => update({ checks: { ...draft.checks, [option.id]: state } })}
                size="compact"
                wrap
                testID={`${testID}.check.${option.id}`}
              />
            </View>
          ))}
        </Section>
      )}
      {options.accessories.length === 0 ? null : (
        <Section title={tn('repair.condition.peripherals')}>
          <View style={styles.chips}>
            {options.accessories.map((option) => (
              <ToggleChip
                key={option.id}
                label={optionLabel('accessories', option)}
                selected={draft.peripherals.includes(option.id)}
                onToggle={() => togglePeripheral(option.id)}
                testID={`${testID}.peripheral.${option.id}`}
              />
            ))}
          </View>
        </Section>
      )}
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.condition.notes')}
          value={draft.intakeNotes}
          onChangeText={(intakeNotes) => update({ intakeNotes })}
          multiline
          testID={`${testID}.notes`}
        />
      </View>
    </View>
  );
}

export function PhotosStep({
  draft,
  angles,
  onTake,
  testID,
}: {
  readonly draft: IntakeDraft;
  readonly angles: readonly IntakeOption[];
  readonly onTake: (angle: IntakeOption) => void;
  readonly testID: string;
}): React.JSX.Element {
  return (
    <View>
      <Text style={repairStyles.muted}>{tn('repair.photo.intakeHint')}</Text>
      <View style={repairStyles.gap}>
        <PhotoGrid>
          {angles.map((angle) => {
            const slot = angle.id;
            const photo = draft.photos[slot];
            return (
              <View key={slot} style={repairStyles.gridCell}>
                <PhotoSlot
                  label={optionLabel('photoAngles', angle)}
                  actionLabel={tn(
                    photo === undefined ? 'repair.photo.take' : 'repair.photo.retake',
                  )}
                  image={
                    photo === undefined ? null : (
                      <PhotoThumb
                        photo={capturedThumbnailRef(photo)}
                        testID={`${testID}.thumb.${slot}`}
                      />
                    )
                  }
                  onPress={() => onTake(angle)}
                  testID={`${testID}.slot.${slot}`}
                />
              </View>
            );
          })}
        </PhotoGrid>
      </View>
    </View>
  );
}

const EMPTY_LINE: QuoteLineDraft = { kind: 'part', description: '', amount: 0 };

/** "650.000" for 650000, empty for nothing typed yet: the amount reads as the customer hears it. */
function amountText(amount: number): string {
  return amount === 0 ? '' : formatNumber(amount);
}

/**
 * Price lines edited where they stand, so nothing typed waits on a separate "add" press to count.
 * With no lines yet one empty line is shown; it joins the draft only once something is typed.
 */
export function PriceStep({
  draft,
  update,
  options,
  lineError,
  downPaymentError,
  testID,
}: StepProps & {
  readonly lineError: string | undefined;
  readonly downPaymentError: string | undefined;
}): React.JSX.Element {
  const kinds = usePriceKinds();
  const lines = draft.lines.length === 0 ? [EMPTY_LINE] : draft.lines;
  const setLine = (index: number, patch: Partial<QuoteLineDraft>): void =>
    update({ lines: lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) });

  return (
    <View>
      {lines.map((line, index) => (
        <View key={index} style={index === 0 ? undefined : repairStyles.gap}>
          <Card testID={`${testID}.line.${index}`}>
            <SegmentedControl
              options={kinds.map((value) => ({
                value,
                label: tn(PRICE_KIND_KEY[value]),
              }))}
              value={line.kind as PriceKind}
              onChange={(kind) => setLine(index, { kind })}
              size="compact"
              testID={`${testID}.kind.${index}`}
            />
            <View style={repairStyles.gap}>
              <TextInput
                label={tn('repair.price.description')}
                value={line.description}
                onChangeText={(description) => setLine(index, { description })}
                errorMessage={
                  line.description.trim() === '' && line.amount !== 0 ? lineError : undefined
                }
                testID={`${testID}.description.${index}`}
              />
            </View>
            <View style={repairStyles.gap}>
              <TextInput
                label={tn('repair.price.amount')}
                value={amountText(line.amount)}
                onChangeText={(text) => {
                  if (acceptsRupiahText(text)) setLine(index, { amount: parseRupiah(text) ?? 0 });
                }}
                keyboardType="number-pad"
                testID={`${testID}.amount.${index}`}
              />
            </View>
            {lines.length > 1 ? (
              <View style={styles.remove}>
                <TextButton
                  label={t('core.action.delete')}
                  icon="remove"
                  tone="danger"
                  onPress={() => update({ lines: lines.filter((_, i) => i !== index) })}
                  testID={`${testID}.remove.${index}`}
                />
              </View>
            ) : null}
          </Card>
        </View>
      ))}
      <View style={repairStyles.gap}>
        <TextButton
          label={tn('repair.price.addRow')}
          icon="add"
          onPress={() => update({ lines: [...lines, EMPTY_LINE] })}
          testID={`${testID}.addRow`}
        />
      </View>
      <View style={[repairStyles.row, styles.total]}>
        <Text style={styles.reviewStrong}>{tn('repair.price.total')}</Text>
        <Text style={repairStyles.heading} testID={`${testID}.total`}>
          {formatMoney(intakeTotal(draft.lines))}
        </Text>
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.price.downPaymentInput')}
          value={amountText(intakeDownPayment(draft))}
          onChangeText={(text) => {
            if (acceptsRupiahText(text)) update({ downPayment: text.replace(/\D/g, '') });
          }}
          keyboardType="number-pad"
          errorMessage={downPaymentError}
          testID={`${testID}.downPaymentInput`}
        />
      </View>
      <DownPaymentRows
        total={intakeTotal(draft.lines)}
        downPayment={intakeDownPayment(draft)}
        testID={testID}
      />
      <Section title={tn('repair.ticket.readyBy')}>
        <SegmentedControl
          options={options.readyBy.map(({ id }) => ({ value: id, label: readyLabel(id) }))}
          value={chosenReady(draft, options.readyBy)}
          onChange={(ready) => update({ ready })}
          size="compact"
          wrap
          testID={`${testID}.ready`}
        />
      </Section>
    </View>
  );
}

export function ReviewStep({
  draft,
  options,
  onEdit,
  photoStrip,
  testID,
}: {
  readonly draft: IntakeDraft;
  readonly options: IntakeOptionLists;
  readonly onEdit: (step: number) => void;
  /** The captured photos as a strip that opens full screen (the wizard owns the viewer). */
  readonly photoStrip: React.ReactNode;
  readonly testID: string;
}): React.JSX.Element {
  const issues = checksWithIssue(draft, options.checks);
  const accessories = chosenAccessories(draft, options.accessories);
  const section = (step: IntakeStep, children: React.ReactNode): React.JSX.Element => (
    <Section
      title={tn(INTAKE_STEP_KEY[step])}
      action={
        <TextButton
          label={t('core.action.edit')}
          icon="edit"
          onPress={() => onEdit(INTAKE_STEPS.indexOf(step))}
          testID={`${testID}.edit.${step}`}
        />
      }
    >
      {children}
    </Section>
  );
  return (
    <View>
      {section(
        'customer',
        <>
          <Text style={styles.reviewStrong} testID={`${testID}.customer`}>
            {draft.customer.name}
          </Text>
          {draft.customer.phone === null || draft.customer.phone === '' ? null : (
            <Text style={repairStyles.muted}>{formatPhone(draft.customer.phone)}</Text>
          )}
        </>,
      )}
      {section(
        'device',
        <>
          <Text style={styles.reviewStrong} testID={`${testID}.device`}>
            {[draft.device.brand, draft.device.model, draft.device.color]
              .filter((s) => s.trim() !== '')
              .join(' ')}
          </Text>
          {draft.device.imei === '' ? null : (
            <Field label={tn('repair.device.imei')} value={draft.device.imei} />
          )}
        </>,
      )}
      {section(
        'condition',
        <>
          <Text style={styles.reviewText}>{draft.complaint}</Text>
          {issues.length === 0 ? null : (
            <Field
              label={tn('repair.condition.issues')}
              value={issues.map((check) => optionLabel('checks', check)).join(', ')}
            />
          )}
          {accessories.length === 0 ? null : (
            <Field
              label={tn('repair.condition.peripherals')}
              value={accessories.map((item) => optionLabel('accessories', item)).join(', ')}
            />
          )}
        </>,
      )}
      {section('photos', photoStrip)}
      {section(
        'price',
        <>
          {draft.lines
            .filter((line) => line.description.trim() !== '')
            .map((line, index) => (
              <View key={index} style={[repairStyles.row, styles.reviewLine, styles.topAligned]}>
                <View style={repairStyles.rowText}>
                  <Text style={styles.reviewText}>{line.description}</Text>
                  <Text style={repairStyles.caption}>{tn(PRICE_KIND_KEY[line.kind])}</Text>
                </View>
                <Text style={styles.reviewText}>
                  {formatMoney(signedAmount(line.kind, line.amount))}
                </Text>
              </View>
            ))}
          <View style={[repairStyles.row, styles.reviewTotal]}>
            <Text style={styles.reviewStrong}>{tn('repair.price.total')}</Text>
            <Text style={repairStyles.heading} testID={`${testID}.total`}>
              {formatMoney(intakeTotal(draft.lines))}
            </Text>
          </View>
          <DownPaymentRows
            total={intakeTotal(draft.lines)}
            downPayment={intakeDownPayment(draft)}
            testID={testID}
          />
          <Field
            label={tn('repair.ticket.readyBy')}
            value={readyLabel(chosenReady(draft, options.readyBy))}
          />
        </>,
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  check: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: space.md,
    paddingVertical: space.xs,
  },
  checkDivider: { borderTopWidth: border.hairline, borderTopColor: color.border },
  checkLabel: { ...type.bodySm, color: color.text, flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  suggestions: { marginTop: space.sm },
  remove: { alignSelf: 'flex-end', marginTop: space.md },
  total: { marginTop: space.lg },
  reviewLine: { marginBottom: space.sm },
  reviewTotal: {
    paddingTop: space.md,
    marginBottom: space.sm,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  reviewStrong: { ...type.bodyBold, color: color.text },
  topAligned: { alignItems: 'flex-start' },
  reviewText: { ...type.bodySm, color: color.text },
});
