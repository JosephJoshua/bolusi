/**
 * The six intake steps the wizard walks through (IntakeWizard.tsx): each edits its part of the one
 * draft through `update` and shows the problems the wizard hands it.
 */
import { formatMoney, formatNumber, formatPhone, t } from '@bolusi/i18n';
import {
  Button,
  Card,
  ChipRow,
  ListRow,
  PatternLock,
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
import { Keyboard, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { CHECKLIST_STATES } from '../constants.js';
import { modelCaption, useModelPicker } from '../model-picker.js';
import { PATTERN_MIN_DOTS, SCREEN_LOCK_KINDS } from '../screen-lock.js';

import { tn } from '../i18n.js';
import {
  CHECK_STATE_KEY,
  INTAKE_STEP_KEY,
  LOCK_KIND_KEY,
  PRICE_KIND_KEY,
  optionLabel,
  readyLabel,
} from '../labels.js';
import {
  INTAKE_STEPS,
  capturedThumbnailRef,
  checksWithIssue,
  chosenAccessories,
  chosenRepairTypes,
  chosenReady,
  intakeDownPayment,
  intakeNeedsVideo,
  intakeTotal,
  acceptsRupiahText,
  phoneText,
  parseRupiah,
  restOfChecksOk,
  toggled,
  signedAmount,
  type IntakeDraft,
  type IntakeStep,
  type QuoteLineDraft,
} from '../flows.js';
import { useSettledValue, type VideoMediaRef } from '../../screen-kit/index.js';
import type { PaymentAccountRow } from '../../money/queries.js';
import { PaymentMethodField } from '../../money/screens/PaymentMethodField.js';
import type { IntakeOption, IntakeOptionLists } from '../intake-options.js';
import {
  CatalogPhoto,
  DownPaymentRows,
  Field,
  ModelPhoto,
  PhotoGrid,
  PhotoThumb,
  Section,
  repairStyles,
  usePhotoGridCell,
} from './parts.js';
import { useRepairQuery } from '../runtime.js';
import { usePriceKinds, type PriceKind } from './TicketSteps.js';
import { OwnershipVideoTile } from './video.js';

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
  phoneError,
  testID,
}: StepProps & {
  readonly nameError: string | undefined;
  readonly phoneError: string | undefined;
}): React.JSX.Element {
  const customer = draft.customer;
  const typed = customer.kind === 'new' ? [customer.name, customer.phone].join(' ').trim() : '';
  // Matched once the counter pauses typing, not on every key; a cleared name clears them at once.
  const settledText = useSettledValue(typed);
  const searchText = typed.length < 2 ? '' : settledText;
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
        autoCorrect={false}
        autoCapitalize="words"
        testID={`${testID}.name`}
      />
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.customer.phone')}
          placeholder={tn('repair.customer.phoneHint')}
          value={customer.phone}
          onChangeText={(phone) => update({ customer: { ...customer, phone: phoneText(phone) } })}
          keyboardType="phone-pad"
          errorMessage={phoneError}
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

/**
 * The phone being taken in. The model comes first and is all most intakes need: as it is typed,
 * models from the phone catalog and from earlier intakes are suggested with their picture, and a
 * model the catalog knows fills in its brand and offers its colours. The field moves to the top
 * of the screen when focused, so the suggestions get the room above the on-screen keyboard.
 * Nothing here is required to match: a model nobody has heard of is typed and kept as it is.
 */
export function DeviceStep({
  draft,
  update,
  options,
  brandError,
  modelError,
  imeiError,
  lockError,
  testID,
}: StepProps & {
  readonly brandError: string | undefined;
  readonly modelError: string | undefined;
  readonly imeiError: string | undefined;
  readonly lockError: string | undefined;
}): React.JSX.Element {
  const device = draft.device;
  const set = (patch: Partial<IntakeDraft['device']>): void =>
    update({ device: { ...device, ...patch } });
  const { matched, suggestions, memory, colours, pick, tidyModel } = useModelPicker(device, set);

  return (
    <View>
      <TextInput
        label={tn('repair.device.model')}
        placeholder={tn('repair.device.modelHint')}
        value={device.model}
        onChangeText={(value) => set({ model: value })}
        onBlur={tidyModel}
        errorMessage={modelError}
        autoCorrect={false}
        revealOnFocus="to-top"
        testID={`${testID}.model`}
      />
      {suggestions.length > 0 ? (
        <View style={styles.modelList} testID={`${testID}.models`}>
          {suggestions.map((row) => (
            <ListRow
              key={row.key}
              leading={<ModelPhoto photo={row.photo} testID={`${testID}.model.${row.key}.photo`} />}
              primaryText={row.model}
              secondaryText={modelCaption(row)}
              onPress={() => {
                pick(row);
                Keyboard.dismiss();
              }}
              testID={`${testID}.model.${row.key}`}
            />
          ))}
        </View>
      ) : null}
      {matched !== null ? (
        <View style={styles.modelMatch} testID={`${testID}.modelMatch`}>
          <ModelPhoto photo={matched.photo} large testID={`${testID}.modelMatch.photo`} />
          <View style={repairStyles.rowText}>
            <Text style={styles.reviewStrong}>
              {matched.brand} {matched.model}
            </Text>
            {matched.announcedYear === null ? null : (
              <Text style={repairStyles.muted}>
                {tn('repair.device.released', { year: String(matched.announcedYear) })}
              </Text>
            )}
            {memory.length === 0 ? null : (
              <Text style={repairStyles.muted} testID={`${testID}.modelMatch.memory`}>
                {memory.join(' · ')}
              </Text>
            )}
          </View>
        </View>
      ) : null}
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.device.brand')}
          value={device.brand}
          onChangeText={(value) => set({ brand: value })}
          errorMessage={brandError}
          autoCorrect={false}
          testID={`${testID}.brand`}
        />
        {/* Quick picks only while the brand is still open; a catalog model already gave it. */}
        {matched !== null ? null : (
          <View style={styles.suggestions}>
            <ChipRow testID={`${testID}.brandChoices`}>
              {options.brands.map((option) => {
                const choice = optionLabel('brands', option);
                return (
                  <ToggleChip
                    key={option.id}
                    label={choice}
                    selected={device.brand === choice}
                    onToggle={() => set({ brand: choice })}
                    testID={`${testID}.brandChoice.${choice}`}
                  />
                );
              })}
            </ChipRow>
          </View>
        )}
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.device.colorField')}
          value={device.color}
          onChangeText={(color) => set({ color })}
          autoCorrect={false}
          testID={`${testID}.color`}
        />
        {colours.length === 0 ? null : (
          <View style={styles.suggestions}>
            <ChipRow testID={`${testID}.colours`}>
              {colours.map((colour) => (
                <ToggleChip
                  key={colour}
                  label={colour}
                  selected={device.color === colour}
                  onToggle={() => set({ color: device.color === colour ? '' : colour })}
                  testID={`${testID}.colour.${colour}`}
                />
              ))}
            </ChipRow>
          </View>
        )}
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.device.imeiField')}
          value={device.imei}
          onChangeText={(imei) => set({ imei: imei.replace(/[^\d\s-]/g, '') })}
          keyboardType="number-pad"
          errorMessage={imeiError}
          testID={`${testID}.imei`}
        />
      </View>
      <ScreenLockField
        kind={device.lockKind}
        value={device.passcode}
        onChange={(lockKind, passcode) => set({ lockKind, passcode })}
        error={lockError}
        testID={`${testID}.lock`}
      />
    </View>
  );
}

/**
 * How the phone is unlocked: nothing, a PIN, a password, or a pattern drawn on the pad the way the
 * customer draws it. A typed PIN or password stays hidden, so it is not read over the counter, with
 * an eye button to check it with the customer.
 */
function ScreenLockField({
  kind,
  value,
  onChange,
  error,
  testID,
}: {
  readonly kind: IntakeDraft['device']['lockKind'];
  readonly value: string;
  readonly onChange: (kind: IntakeDraft['device']['lockKind'], value: string) => void;
  /** Set when a lock kind is chosen but nothing was entered for it. */
  readonly error: string | undefined;
  readonly testID: string;
}): React.JSX.Element {
  const [tooShort, setTooShort] = useState(false);
  const revealLabels = { show: tn('repair.passcode.show'), hide: tn('repair.passcode.hide') };
  return (
    <View style={repairStyles.gap} testID={testID}>
      <Text style={styles.fieldLabel}>{tn('repair.device.passcode')}</Text>
      <SegmentedControl
        options={(['none', ...SCREEN_LOCK_KINDS] as const).map((option) => ({
          value: option,
          label: tn(LOCK_KIND_KEY[option]),
        }))}
        value={kind}
        onChange={(next) => {
          setTooShort(false);
          if (next !== kind) onChange(next, '');
        }}
        size="compact"
        testID={`${testID}.kind`}
      />
      {kind === 'pin' ? (
        <View style={styles.suggestions}>
          <TextInput
            label={tn('repair.lock.pinField')}
            value={value}
            onChangeText={(text) => onChange('pin', text.replace(/\D/g, ''))}
            keyboardType="number-pad"
            secureTextEntry
            revealLabels={revealLabels}
            errorMessage={error}
            autoFocus
            testID={`${testID}.pin`}
          />
        </View>
      ) : null}
      {kind === 'password' ? (
        <View style={styles.suggestions}>
          <TextInput
            label={tn('repair.lock.passwordField')}
            value={value}
            onChangeText={(text) => onChange('password', text)}
            secureTextEntry
            revealLabels={revealLabels}
            errorMessage={error}
            autoFocus
            testID={`${testID}.password`}
          />
        </View>
      ) : null}
      {kind === 'pattern' ? (
        <View style={styles.suggestions}>
          <Text
            style={tooShort || error !== undefined ? styles.patternProblem : repairStyles.muted}
            testID={`${testID}.pattern.hint`}
          >
            {tooShort ? tn('repair.lock.patternShort') : (error ?? tn('repair.lock.patternHint'))}
          </Text>
          <View style={styles.patternPad}>
            <PatternLock
              value={value}
              onChange={(drawn) => {
                // A pattern shorter than Android allows was not finished: draw it again.
                const finished = drawn.length >= PATTERN_MIN_DOTS;
                setTooShort(!finished);
                onChange('pattern', finished ? drawn : '');
              }}
              accessibilityLabel={tn('repair.lock.patternLabel')}
              testID={`${testID}.pattern`}
            />
          </View>
          {value === '' ? null : (
            <View style={styles.patternActions}>
              <TextButton
                label={tn('repair.lock.patternRedo')}
                onPress={() => onChange('pattern', '')}
                testID={`${testID}.pattern.redo`}
              />
            </View>
          )}
        </View>
      ) : null}
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
  const { width, fontScale } = useWindowDimensions();
  const stackChecks = width - CHECK_ROW_CHROME < CHECK_ROW_TEXT * fontScale;
  const togglePeripheral = (item: string): void =>
    update({ peripherals: toggled(draft.peripherals, item) });
  const toggleRepairType = (item: string): void =>
    update({ repairTypes: toggled(draft.repairTypes, item) });
  return (
    <View>
      <TextInput
        label={tn('repair.condition.complaint')}
        value={draft.complaint}
        onChangeText={(complaint) => update({ complaint })}
        errorMessage={complaintError}
        multiline
        testID={`${testID}.complaint`}
      />
      {/* What the counter expects to fix; the technician can change it after the diagnosis. A claim
          repairs what its servisan did, so it has none of its own. */}
      {options.repairTypes.length === 0 || draft.claimOf !== null ? null : (
        <Section title={tn('repair.condition.repairTypes')}>
          <ChipRow testID={`${testID}.repairTypes`}>
            {options.repairTypes.map((option) => (
              <ToggleChip
                key={option.id}
                label={optionLabel('repairTypes', option)}
                selected={draft.repairTypes.includes(option.id)}
                onToggle={() => toggleRepairType(option.id)}
                testID={`${testID}.repairType.${option.id}`}
              />
            ))}
          </ChipRow>
        </Section>
      )}
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
            // One line per check: the name on the left, its state lined up on the right, so the
            // column of choices reads straight down. On a narrow phone or a large system font the
            // states do not fit beside the name, and squeezing them cut "Tidak dicek" to "Tidak"
            // on the first Android run; there the states go under the name instead.
            <View
              key={option.id}
              style={[
                styles.check,
                stackChecks ? styles.checkStacked : null,
                index === 0 ? null : styles.checkDivider,
              ]}
              testID={`${testID}.checkRow.${option.id}`}
            >
              <Text style={[styles.checkLabel, stackChecks ? null : styles.checkLabelBeside]}>
                {optionLabel('checks', option)}
              </Text>
              <SegmentedControl
                options={CHECKLIST_STATES.map((value) => ({
                  value,
                  label: tn(CHECK_STATE_KEY[value]),
                }))}
                value={draft.checks[option.id] ?? 'not_checked'}
                onChange={(state) => update({ checks: { ...draft.checks, [option.id]: state } })}
                size="compact"
                inline
                testID={`${testID}.check.${option.id}`}
              />
            </View>
          ))}
        </Section>
      )}
      {options.accessories.length === 0 ? null : (
        <Section title={tn('repair.condition.peripherals')}>
          <ChipRow testID={`${testID}.peripherals`}>
            {options.accessories.map((option) => (
              <ToggleChip
                key={option.id}
                label={optionLabel('accessories', option)}
                selected={draft.peripherals.includes(option.id)}
                onToggle={() => togglePeripheral(option.id)}
                testID={`${testID}.peripheral.${option.id}`}
              />
            ))}
          </ChipRow>
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
  needsVideo,
  onRecordVideo,
  onPlayVideo,
  testID,
}: {
  readonly draft: IntakeDraft;
  readonly angles: readonly IntakeOption[];
  readonly onTake: (angle: IntakeOption) => void;
  /** A picked repair type asks for the ownership video, taken here with the photos. */
  readonly needsVideo: boolean;
  readonly onRecordVideo: (() => void) | undefined;
  readonly onPlayVideo: ((video: VideoMediaRef) => void) | undefined;
  readonly testID: string;
}): React.JSX.Element {
  const gridCell = usePhotoGridCell();
  return (
    <View>
      <Text style={repairStyles.muted}>{tn('repair.photo.intakeHint')}</Text>
      <View style={repairStyles.gap}>
        <PhotoGrid>
          {angles.map((angle) => {
            const slot = angle.id;
            const photo = draft.photos[slot];
            return (
              <View key={slot} style={gridCell}>
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
      {needsVideo ? (
        <View style={styles.videoSection} testID={`${testID}.video`}>
          <Text style={styles.sectionTitle}>{tn('repair.video.title')}</Text>
          <Text style={repairStyles.muted}>{tn('repair.video.hint')}</Text>
          <OwnershipVideoTile
            video={draft.ownershipVideo}
            onRecord={onRecordVideo}
            onPlay={onPlayVideo}
            testID={`${testID}.video.tile`}
          />
        </View>
      ) : null}
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
  accounts,
  referenceError,
  testID,
}: StepProps & {
  readonly lineError: string | undefined;
  readonly downPaymentError: string | undefined;
  /** The store's payment methods besides cash, for how the DP came in. */
  readonly accounts: readonly PaymentAccountRow[];
  readonly referenceError: string | undefined;
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
                selectTextOnFocus
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
          selectTextOnFocus
          errorMessage={downPaymentError}
          testID={`${testID}.downPaymentInput`}
        />
      </View>
      {intakeDownPayment(draft) > 0 ? (
        <View style={repairStyles.gap}>
          <PaymentMethodField
            accounts={accounts}
            account={draft.downPaymentAccount}
            reference={draft.downPaymentReference}
            onChange={({ account, reference }) =>
              update({ downPaymentAccount: account, downPaymentReference: reference })
            }
            referenceError={referenceError}
            testID={`${testID}.downPaymentMethod`}
          />
        </View>
      ) : null}
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
  const repairTypes = chosenRepairTypes(draft, options.repairTypes);
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
          <View style={styles.reviewDevice}>
            <CatalogPhoto
              brand={draft.device.brand}
              model={draft.device.model}
              testID={`${testID}.devicePhoto`}
            />
            <Text
              style={[styles.reviewStrong, styles.reviewDeviceName]}
              testID={`${testID}.device`}
            >
              {[draft.device.brand, draft.device.model, draft.device.color]
                .filter((s) => s.trim() !== '')
                .join(' ')}
            </Text>
          </View>
          {draft.device.imei === '' ? null : (
            <Field label={tn('repair.device.imei')} value={draft.device.imei} />
          )}
          {/* Which lock was noted, not the code itself: the review is read out at the counter. */}
          {draft.device.lockKind === 'none' || draft.device.passcode === '' ? null : (
            <Field
              label={tn('repair.device.passcodeLabel')}
              value={tn(LOCK_KIND_KEY[draft.device.lockKind])}
              testID={`${testID}.lock`}
            />
          )}
        </>,
      )}
      {section(
        'condition',
        <>
          <Text style={styles.reviewText}>{draft.complaint}</Text>
          {repairTypes.length === 0 ? null : (
            <Field
              label={tn('repair.condition.repairTypes')}
              value={repairTypes.map((type) => optionLabel('repairTypes', type)).join(', ')}
              testID={`${testID}.repairTypes`}
            />
          )}
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
      {section(
        'photos',
        <>
          {photoStrip}
          {intakeNeedsVideo(draft, options) && draft.ownershipVideo !== null ? (
            <Field
              label={tn('repair.video.title')}
              value={tn('repair.video.recorded')}
              testID={`${testID}.video`}
            />
          ) : null}
        </>,
      )}
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

/**
 * When a condition check fits on one line: its three compact state pills plus a short name need
 * about 340 dp of text room, which grows with the system font; the gutters and gaps do not. A
 * 411 dp phone at normal font keeps one line; a 360 dp phone, or a large font, stacks.
 */
const CHECK_ROW_TEXT = 340;
const CHECK_ROW_CHROME = 2 * space.lg + space.md;

const styles = StyleSheet.create({
  // The divider gets real room on both sides: tight against the pills it read as cramped.
  check: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: space.md,
    paddingVertical: space.md,
  },
  checkStacked: { flexDirection: 'column', alignItems: 'flex-start', rowGap: space.sm },
  checkDivider: { borderTopWidth: border.hairline, borderTopColor: color.border },
  checkLabel: { ...type.bodySm, color: color.text },
  sectionTitle: { ...type.bodyBold, color: color.text },
  videoSection: { marginTop: space.lg, gap: space.sm },
  checkLabelBeside: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  suggestions: { marginTop: space.sm },
  fieldLabel: { ...type.caption, color: color.textMuted, marginBottom: space.xs },
  patternProblem: { ...type.bodySm, color: color.danger },
  patternPad: { alignItems: 'center' },
  patternActions: { alignItems: 'center', marginTop: space.xs },
  modelMatch: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.md,
    columnGap: space.md,
  },
  modelList: { marginTop: space.sm },
  reviewDevice: { flexDirection: 'row', alignItems: 'center', columnGap: space.md },
  reviewDeviceName: { flexShrink: 1 },
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
