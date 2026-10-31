/**
 * PrintSettingsScreen — what this store's slips print besides the servisan: the header (name,
 * address, phone, logo) and the terms on each slip. The owner edits them here; every device in the
 * store prints them. The terms start as the app's own, so the owner edits rather than writes them.
 * Leaving with unsaved changes asks first.
 */
import {
  ConfirmSheet,
  SwitchRow,
  TextButton,
  TextInput,
  color,
  radius,
  space,
  type,
  Text,
} from '@bolusi/ui';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { MediaRefMime } from '@bolusi/schemas';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';
import { tn } from '../i18n.js';
import {
  printSettingsForm,
  printSettingsInput,
  samePrintSettingsForm,
  type PrintSettingsForm,
  type PrintSettingsLogo,
} from '../print-settings-form.js';
import type { PrintSettings } from '../queries.js';
import { FlowScreen, QueryView, Section, repairStyles, type RepairChrome } from './parts.js';
import {
  usePrintSettings,
  usePrintStoreName,
  useRepairRuntime,
  useRepairThumbnail,
} from '../runtime.js';

export interface PrintSettingsScreenProps {
  readonly chrome: RepairChrome;
  readonly onClose: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function PrintSettingsScreen({
  chrome,
  onClose,
  onRegisterDiscardGuard,
  testID = 'repair.printSettings',
}: PrintSettingsScreenProps): React.JSX.Element {
  const [reloadNonce, setReloadNonce] = useState(0);
  const settings = usePrintSettings(reloadNonce);
  return (
    <QueryView
      query={settings}
      onBack={onClose}
      onRetry={() => setReloadNonce((n) => n + 1)}
      testID={testID}
    >
      {(saved) => (
        <SettingsForm
          saved={saved}
          chrome={chrome}
          onClose={onClose}
          onRegisterDiscardGuard={onRegisterDiscardGuard}
          testID={testID}
        />
      )}
    </QueryView>
  );
}

type Logo = PrintSettingsLogo;
type Form = PrintSettingsForm;

function SettingsForm({
  saved,
  chrome,
  onClose,
  onRegisterDiscardGuard,
  testID,
}: {
  readonly saved: PrintSettings;
  readonly chrome: RepairChrome;
  readonly onClose: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID: string;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [form, setForm] = useState<Form>(() => printSettingsForm(saved));
  const [baseline, setBaseline] = useState<Form>(() => printSettingsForm(saved));
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const dirty = !samePrintSettingsForm(form, baseline);
  const storeName = usePrintStoreName();

  useEffect(() => {
    onRegisterDiscardGuard?.(dirty ? (proceed) => setPendingLeave(() => proceed) : null);
    return () => onRegisterDiscardGuard?.(null);
  }, [dirty, onRegisterDiscardGuard]);

  const edit = (patch: Partial<Form>): void => {
    setNotice(null);
    setForm((current) => ({ ...current, ...patch }));
  };

  const pickLogo = (): void => {
    const pick = runtime.pickPhoto;
    if (pick === undefined) return;
    void runner
      .run(() => pick({ title: tn('repair.printSettings.logoTitle') }))
      .then((picked) => {
        if (picked !== undefined && picked !== null) edit({ logo: picked.mediaRef });
      });
  };

  const save = (): void => {
    if (!dirty) {
      onClose();
      return;
    }
    void runner
      .run(() => runtime.run('setPrintSettings', printSettingsInput(form)))
      .then((result) => {
        if (result === undefined) return;
        setBaseline(form);
        setNotice(tn('repair.printSettings.saved'));
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.printSettings.title')}
      onBack={() => (dirty ? setPendingLeave(() => onClose) : onClose())}
      primaryLabel={tn('repair.printSettings.save')}
      onPrimary={save}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      notice={notice}
      onClearNotice={() => setNotice(null)}
      overlay={
        pendingLeave === null ? null : (
          <ConfirmSheet
            title={tn('repair.options.discardTitle')}
            message={tn('repair.options.discardMessage')}
            confirmLabel={tn('repair.options.discard')}
            onConfirm={() => {
              const proceed = pendingLeave;
              setPendingLeave(null);
              proceed();
            }}
            cancelLabel={tn('repair.options.keepEditing')}
            onCancel={() => setPendingLeave(null)}
            testID={`${testID}.discard`}
          />
        )
      }
      testID={testID}
    >
      <Section first title={tn('repair.printSettings.header')} testID={`${testID}.header`}>
        {runtime.pickPhoto === undefined && form.logo === null ? null : (
          // The logo and whether dot-matrix prints it read as one setting.
          <View style={styles.logoGroup}>
            <LogoRow
              logo={form.logo}
              canPick={runtime.pickPhoto !== undefined}
              disabled={runner.busy}
              onPick={pickLogo}
              onRemove={() => edit({ logo: null, logoOnDotMatrix: false })}
              testID={`${testID}.logo`}
            />
            {form.logo === null ? null : (
              <SwitchRow
                label={tn('repair.printSettings.logoOnDotMatrix')}
                caption={tn('repair.printSettings.logoOnDotMatrixHint')}
                value={form.logoOnDotMatrix}
                onValueChange={(logoOnDotMatrix) => edit({ logoOnDotMatrix })}
                testID={`${testID}.logoOnDotMatrix`}
              />
            )}
          </View>
        )}
        <View
          style={
            form.logo === null && runtime.pickPhoto === undefined ? undefined : styles.afterLogo
          }
        >
          <TextInput
            label={tn('repair.printSettings.name')}
            value={form.name}
            onChangeText={(name) => edit({ name })}
            maxLength={100}
            // A shop's own name ("Bolusi Cell") is not a dictionary word to correct.
            autoCorrect={false}
            testID={`${testID}.name`}
          />
          {storeName === '' ? null : (
            <Text style={repairStyles.caption}>
              {tn('repair.printSettings.nameHint', { name: storeName })}
            </Text>
          )}
        </View>
        <View style={repairStyles.gap}>
          <TextInput
            label={tn('repair.printSettings.address')}
            value={form.address}
            onChangeText={(address) => edit({ address })}
            maxLength={300}
            multiline
            testID={`${testID}.address`}
          />
        </View>
        <View style={repairStyles.gap}>
          <TextInput
            label={tn('repair.printSettings.phone')}
            value={form.phone}
            onChangeText={(phone) => edit({ phone })}
            maxLength={100}
            keyboardType="phone-pad"
            testID={`${testID}.phone`}
          />
        </View>
      </Section>
      <Section title={tn('repair.printSettings.terms')} testID={`${testID}.terms`}>
        {/* Said once for both lists, before them. */}
        <Text style={styles.termsHint}>{tn('repair.printSettings.termsHint')}</Text>
        <View style={repairStyles.gap}>
          <TextInput
            label={tn('repair.printSettings.intakeTerms')}
            value={form.intakeTerms}
            onChangeText={(intakeTerms) => edit({ intakeTerms })}
            maxLength={2000}
            multiline
            testID={`${testID}.intakeTerms`}
          />
        </View>
        <View style={repairStyles.gap}>
          <TextInput
            label={tn('repair.printSettings.handoverTerms')}
            value={form.handoverTerms}
            onChangeText={(handoverTerms) => edit({ handoverTerms })}
            maxLength={2000}
            multiline
            testID={`${testID}.handoverTerms`}
          />
        </View>
      </Section>
    </FlowScreen>
  );
}

function LogoRow({
  logo,
  canPick,
  disabled,
  onPick,
  onRemove,
  testID,
}: {
  readonly logo: Logo | null;
  readonly canPick: boolean;
  readonly disabled: boolean;
  readonly onPick: () => void;
  readonly onRemove: () => void;
  readonly testID: string;
}): React.JSX.Element {
  const thumbnail = useRepairThumbnail(
    logo === null ? null : { kind: 'signed', ...logo, mime: logo.mime as MediaRefMime },
  );
  return (
    <View style={styles.logoRow} testID={testID}>
      <View style={styles.logoBox}>
        {thumbnail.kind === 'ready' && logo !== null ? (
          <Image
            source={{ uri: thumbnail.uri }}
            contentFit="contain"
            style={styles.logo}
            testID={`${testID}.image`}
          />
        ) : (
          <Text style={repairStyles.caption}>{tn('repair.printSettings.logo')}</Text>
        )}
      </View>
      <View style={styles.logoActions}>
        {canPick ? (
          <TextButton
            label={tn(
              logo === null ? 'repair.printSettings.pickLogo' : 'repair.printSettings.changeLogo',
            )}
            icon={logo === null ? 'add' : undefined}
            onPress={onPick}
            disabled={disabled}
            testID={`${testID}.pick`}
          />
        ) : null}
        {logo === null ? null : (
          <TextButton
            label={tn('repair.printSettings.removeLogo')}
            tone="danger"
            onPress={onRemove}
            disabled={disabled}
            testID={`${testID}.remove`}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  logoGroup: { gap: space.md },
  // The logo and the typed lines are two groups of the header.
  afterLogo: { marginTop: space.xl },
  termsHint: { ...type.bodySm, color: color.textMuted },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  logoBox: {
    width: 120,
    height: 72,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.sm,
  },
  logo: { width: '100%', height: '100%' },
  logoActions: { flexDirection: 'row', flexWrap: 'wrap', marginLeft: -space.sm },
});
