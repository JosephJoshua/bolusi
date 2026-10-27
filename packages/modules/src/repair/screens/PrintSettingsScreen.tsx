/**
 * PrintSettingsScreen — what this store's slips print besides the servisan: the header (name,
 * address, phone, logo) and the terms on each slip. The owner edits them here; every device in the
 * store prints them. The terms start as the app's own, so the owner edits rather than writes them.
 * Leaving with unsaved changes asks first.
 */
import type { MediaRef } from '@bolusi/schemas';
import { ConfirmSheet, SwitchRow, TextButton, TextInput, color, radius, space } from '@bolusi/ui';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { MediaRefMime } from '@bolusi/schemas';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';
import { tn } from '../i18n.js';
import type { PrintSettings } from '../queries.js';
import { FlowScreen, QueryView, Section, repairStyles, type RepairChrome } from './parts.js';
import { usePrintSettings, useRepairRuntime, useRepairThumbnail } from './runtime.js';

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

/** The logo as the form holds it: the signed ref, whether just picked or as saved. */
type Logo = Pick<MediaRef, 'mediaId' | 'sha256' | 'mime'>;

interface Form {
  readonly name: string;
  readonly address: string;
  readonly phone: string;
  readonly logo: Logo | MediaRef | null;
  readonly logoOnDotMatrix: boolean;
  readonly intakeTerms: string;
  readonly handoverTerms: string;
}

/** The form for saved settings, with the app's terms filled in where the store has none. */
function formFor(saved: PrintSettings): Form {
  return {
    name: saved.name ?? '',
    address: saved.address,
    phone: saved.phone,
    logo: saved.logo === null ? null : { ...saved.logo, mime: saved.logo.mime as MediaRefMime },
    logoOnDotMatrix: saved.logoOnDotMatrix,
    intakeTerms: saved.intakeTerms ?? tn('repair.slip.terms.intake'),
    handoverTerms: saved.handoverTerms ?? tn('repair.slip.terms.handover'),
  };
}

function sameForm(a: Form, b: Form): boolean {
  return (
    a.name.trim() === b.name.trim() &&
    a.address.trim() === b.address.trim() &&
    a.phone.trim() === b.phone.trim() &&
    (a.logo?.mediaId ?? null) === (b.logo?.mediaId ?? null) &&
    a.logoOnDotMatrix === b.logoOnDotMatrix &&
    a.intakeTerms.trim() === b.intakeTerms.trim() &&
    a.handoverTerms.trim() === b.handoverTerms.trim()
  );
}

/** Terms left as the app's own are saved as none, so the store keeps getting the app's wording. */
function termsToSave(text: string, defaults: string): string | null {
  return text.trim() === defaults.trim() ? null : text;
}

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
  const [form, setForm] = useState<Form>(() => formFor(saved));
  const [baseline, setBaseline] = useState<Form>(() => formFor(saved));
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const dirty = !sameForm(form, baseline);
  const storeName = useStoreName();

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
    // A logo picked here carries its whole signed ref; one already saved is unchanged, so the
    // command keeps the stored one.
    const logo = form.logo === null ? null : 'type' in form.logo ? form.logo : undefined;
    void runner
      .run(() =>
        runtime.run('setPrintSettings', {
          name: form.name,
          address: form.address.trim(),
          phone: form.phone.trim(),
          ...(logo === undefined ? {} : { logo }),
          logoOnDotMatrix: form.logoOnDotMatrix,
          intakeTerms: termsToSave(form.intakeTerms, tn('repair.slip.terms.intake')),
          handoverTerms: termsToSave(form.handoverTerms, tn('repair.slip.terms.handover')),
        }),
      )
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
      <Text style={repairStyles.muted}>{tn('repair.printSettings.intro')}</Text>
      <Section title={tn('repair.printSettings.header')} testID={`${testID}.header`}>
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
        <View style={repairStyles.gap}>
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
          <Text style={repairStyles.caption}>{tn('repair.printSettings.termsHint')}</Text>
        </View>
      </Section>
    </FlowScreen>
  );
}

/** The enrolled store name, which prints while the owner leaves the name empty. */
function useStoreName(): string {
  const printing = useRepairRuntime().printing;
  const [name, setName] = useState('');
  useEffect(() => {
    let live = true;
    void printing?.storeName().then((loaded) => {
      if (live) setName(loaded);
    });
    return () => {
      live = false;
    };
  }, [printing]);
  return name;
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
