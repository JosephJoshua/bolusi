/**
 * Renaming this phone from Settings, for someone who may register devices here. Online only: the
 * server takes the name first (api/02-auth, `PATCH /v1/devices/me`), then Settings shows it; a
 * refusal keeps the form with the reason, and back returns to Settings.
 */
import { staffAdminFailure, type StaffAdminFailure } from '@bolusi/core';
import { DEVICE_NAME_MAX } from '@bolusi/device/models/enrollment/model';
import {
  deviceNameProblem,
  RENAME_FAILURE_KEY,
  RENAME_PROBLEM_KEY,
} from '@bolusi/device/models/settings/rename';
import { t } from '@bolusi/i18n';
import { AppShell, Banner, Button, TextInput, color, space, type } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

export function RenameDeviceScreen({
  current,
  onRename,
  onClose,
}: {
  readonly current: string;
  /** REJECTS with a `StaffAdminError`. */
  readonly onRename: (name: string) => Promise<void>;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(current);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StaffAdminFailure | null>(null);
  const problem = deviceNameProblem(name);
  const nameProblem = attempted && problem !== null ? t(RENAME_PROBLEM_KEY[problem]) : undefined;

  const save = (): void => {
    setAttempted(true);
    if (problem !== null || busy) return;
    if (name.trim() === current) {
      onClose();
      return;
    }
    setBusy(true);
    setFailure(null);
    onRename(name.trim()).then(onClose, (error: unknown) => {
      setBusy(false);
      setFailure(staffAdminFailure(error));
    });
  };

  return (
    <AppShell
      scrollable
      title={t('auth.rename.titlePhone')}
      titleVariant="detail"
      onBack={() => (busy ? undefined : onClose())}
      backLabel={t('core.action.back')}
      syncChip={null}
      avatar={<View testID="rename-device-no-avatar" />}
      banner={
        failure === null ? undefined : (
          <Banner
            variant={failure === 'offline' ? 'warning' : 'danger'}
            message={t(RENAME_FAILURE_KEY[failure])}
            testID="rename-device-failure"
          />
        )
      }
      bottomAction={
        <Button
          label={t('core.action.save')}
          onPress={save}
          busy={busy}
          testID="rename-device-save"
        />
      }
      testID="rename-device-screen"
    >
      <View style={styles.form}>
        <TextInput
          label={t('auth.enroll.deviceNameField')}
          value={name}
          onChangeText={(next) => {
            setFailure(null);
            setName(next);
          }}
          autoCapitalize="words"
          autoCorrect={false}
          maxLength={DEVICE_NAME_MAX}
          errorMessage={nameProblem}
          disabled={busy}
          // The owner opened this to type a name.
          autoFocus
          testID="rename-device-name"
        />
        {nameProblem === undefined ? (
          <Text style={styles.hint}>{t('auth.rename.hint')}</Text>
        ) : null}
      </View>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  form: { paddingTop: space.md },
  hint: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
});
