/**
 * The first run of a newly registered phone, for the owner who registered it: the camera and
 * notification permissions asked up front with their reason (not mid-intake with a customer
 * waiting), the paper slips print on with a test page, then what is ready. Nothing blocks: "Nanti
 * saja" ends it, and Settings opens it again.
 */
import { t } from '@bolusi/i18n';
import {
  AppShell,
  Button,
  Chip,
  Fact,
  FactGrid,
  Icon,
  ListRow,
  OutcomeState,
  StepHeader,
  TextButton,
  color,
  size,
  space,
} from '@bolusi/ui';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import type { SurfaceNav } from '../../navigation/surface.js';
import type { PermissionPort } from '../../push/permission.js';

/** What the OS says about one permission: asked and given, still askable, or refused for good. */
export type PermissionAnswer = 'granted' | 'ask' | 'blocked';

export interface DeviceSetupScreenProps {
  readonly syncChip: ReactNode;
  readonly camera?: PermissionPort | undefined;
  readonly notifications?: PermissionPort | undefined;
  /** The OS settings for this app, where a refused permission is turned back on. */
  readonly onOpenSystemSettings: () => void;
  /** The paper step's body and the chosen paper's name; absent where nothing prints. */
  readonly paper?: { readonly choice: ReactNode; readonly label: string | null } | undefined;
  /** On the last step: what the store still lacks, each leading to its setting. */
  readonly basics?: ReactNode;
  /** Finished or put off: the setup does not open by itself again. */
  readonly onDone: () => void;
  /** Hardware back goes one step back, the same as the header back. */
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
  readonly testID?: string | undefined;
}

type Step = 'permissions' | 'paper' | 'done';

export function DeviceSetupScreen({
  syncChip,
  camera,
  notifications,
  onOpenSystemSettings,
  paper,
  basics,
  onDone,
  onRegisterSurfaceNav,
  testID = 'setup',
}: DeviceSetupScreenProps): React.JSX.Element {
  const steps: readonly Step[] = paper === undefined ? ['permissions'] : ['permissions', 'paper'];
  const [step, setStep] = useState<Step>('permissions');
  const cameraAnswer = usePermission(camera);
  const notificationAnswer = usePermission(notifications);
  const index = steps.indexOf(step);

  const next = (): void => setStep(steps[index + 1] ?? 'done');
  const back = (): void => {
    if (index > 0) setStep(steps[index - 1]!);
    else if (step === 'done') setStep(steps[steps.length - 1]!);
    else onDone();
  };
  useEffect(() => {
    onRegisterSurfaceNav?.({
      handleBack: () => {
        back();
        return true;
      },
      requestLeave: (proceed) => proceed(),
    });
    return () => onRegisterSurfaceNav?.(null);
  });

  if (step === 'done') {
    const answerLabel = (answer: PermissionAnswer | null): string =>
      t(answer === 'granted' ? 'auth.setup.allowed' : 'auth.setup.notAllowed');
    return (
      <AppShell
        scrollable
        title={t('auth.setup.title')}
        titleVariant="detail"
        onBack={back}
        backLabel={t('core.action.back')}
        syncChip={syncChip}
        avatar={null}
        bottomAction={
          <Button label={t('auth.setup.start')} onPress={onDone} testID={`${testID}.start`} />
        }
        testID={`${testID}.done`}
      >
        <OutcomeState tone="success" icon="success" title={t('auth.setup.doneTitle')}>
          <View style={styles.facts}>
            <FactGrid>
              {camera === undefined ? null : (
                <Fact
                  label={t('auth.setup.camera')}
                  value={answerLabel(cameraAnswer.answer)}
                  testID={`${testID}.done.camera`}
                />
              )}
              {notifications === undefined ? null : (
                <Fact
                  label={t('auth.setup.notifications')}
                  value={answerLabel(notificationAnswer.answer)}
                  testID={`${testID}.done.notifications`}
                />
              )}
              {paper?.label == null ? null : (
                <Fact
                  label={t('auth.setup.paperTitle')}
                  value={paper.label}
                  testID={`${testID}.done.paper`}
                />
              )}
            </FactGrid>
          </View>
        </OutcomeState>
        {basics}
      </AppShell>
    );
  }

  return (
    <AppShell
      scrollable
      scrollKey={step}
      title={t('auth.setup.title')}
      titleVariant="detail"
      onBack={back}
      backLabel={t('core.action.back')}
      syncChip={syncChip}
      avatar={null}
      bottomAction={
        <Button label={t('auth.setup.next')} onPress={next} testID={`${testID}.next`} />
      }
      testID={`${testID}.${step}`}
    >
      <View style={styles.body}>
        <StepHeader
          step={index + 1}
          total={steps.length}
          progressLabel={t('auth.setup.step', { step: index + 1, total: steps.length })}
          title={t(
            step === 'permissions' ? 'auth.setup.permissionsTitle' : 'auth.setup.paperTitle',
          )}
          testID={`${testID}.header`}
        />
        {step === 'permissions' ? (
          <View>
            {camera === undefined ? null : (
              <PermissionRow
                icon="camera"
                title={t('auth.setup.camera')}
                why={t('auth.setup.cameraWhy')}
                state={cameraAnswer}
                onOpenSystemSettings={onOpenSystemSettings}
                testID={`${testID}.camera`}
              />
            )}
            {notifications === undefined ? null : (
              <PermissionRow
                icon="notifications"
                title={t('auth.setup.notifications')}
                why={t('auth.setup.notificationsWhy')}
                state={notificationAnswer}
                onOpenSystemSettings={onOpenSystemSettings}
                testID={`${testID}.notifications`}
              />
            )}
          </View>
        ) : (
          paper?.choice
        )}
        <View style={styles.later}>
          <TextButton label={t('auth.setup.later')} onPress={onDone} testID={`${testID}.later`} />
        </View>
      </View>
    </AppShell>
  );
}

interface PermissionState {
  /** Null until the OS has answered. */
  readonly answer: PermissionAnswer | null;
  readonly request: () => void;
}

/** The OS's answer, read again after asking and whenever the app comes back from the OS settings. */
function usePermission(port: PermissionPort | undefined): PermissionState {
  const [answer, setAnswer] = useState<PermissionAnswer | null>(null);
  const read = useCallback(async (): Promise<void> => {
    if (port === undefined) return;
    try {
      const { granted, canAskAgain } = await port.status();
      setAnswer(granted ? 'granted' : canAskAgain ? 'ask' : 'blocked');
    } catch {
      setAnswer('ask');
    }
  }, [port]);
  useEffect(() => {
    void read();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void read();
    });
    return () => subscription.remove();
  }, [read]);
  const request = useCallback(() => {
    if (port === undefined) return;
    void port
      .request()
      .catch(() => undefined)
      .then(read);
  }, [port, read]);
  return { answer, request };
}

function PermissionRow({
  icon,
  title,
  why,
  state,
  onOpenSystemSettings,
  testID,
}: {
  readonly icon: 'camera' | 'notifications';
  readonly title: string;
  readonly why: string;
  readonly state: PermissionState;
  readonly onOpenSystemSettings: () => void;
  readonly testID: string;
}): React.JSX.Element {
  const { answer } = state;
  return (
    <ListRow
      leading={<Icon name={icon} size={size.iconInline} color={color.textMuted} />}
      primaryText={title}
      secondaryText={answer === 'blocked' ? t('auth.setup.blockedHint') : why}
      below={
        answer === null ? null : answer === 'granted' ? (
          <Chip
            label={t('auth.setup.allowed')}
            icon="check"
            tone="success"
            testID={`${testID}.allowed`}
          />
        ) : answer === 'ask' ? (
          <Button
            label={t('auth.setup.allow')}
            onPress={state.request}
            size="compact"
            testID={`${testID}.allow`}
          />
        ) : (
          <Button
            label={t('auth.setup.openSettings')}
            onPress={onOpenSystemSettings}
            variant="secondary"
            size="compact"
            testID={`${testID}.settings`}
          />
        )
      }
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  body: { gap: space.lg, paddingTop: space.lg },
  later: { alignItems: 'flex-start' },
  facts: { alignSelf: 'stretch', marginTop: space.lg },
});
