/**
 * PaperChoice — the paper this phone prints slips on, saved at once, and a test page to check it
 * through the phone's print dialog. Shared by Settings (PaperScreen) and the new-phone setup.
 */
import { Button, SegmentedControl, TextInput, color, space, Text } from '@bolusi/ui';
import { StyleSheet, View } from 'react-native';

import { useActionRunner } from '../../screen-kit/index.js';
import { tn } from '../i18n.js';
import {
  PAPER_KEY,
  PHONE_PAPERS,
  paperRangeHint,
  useCustomPaperForm,
  useDevicePaper,
  type DevicePaper,
} from '../paper.js';
import { useRepairRuntime } from '../runtime.js';
import { outputTestPage } from '../slip-output.js';
import { ActionErrorBanner, repairStyles } from './parts.js';

export function PaperChoice({
  testID,
  state,
}: {
  readonly testID: string;
  /** The caller's `useDevicePaper`, when it also shows the paper elsewhere; else its own. */
  readonly state?: DevicePaper | undefined;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const printing = runtime.printing;
  const own = useDevicePaper(printing, PHONE_PAPERS);
  const device = state ?? own;
  const runner = useActionRunner();
  return (
    <View style={styles.column}>
      {device.choice === null ? null : (
        <SegmentedControl
          options={PHONE_PAPERS.map((value) => ({ value, label: tn(PAPER_KEY[value]) }))}
          value={device.choice}
          onChange={(next) => void device.choose(next)}
          size="compact"
          testID={`${testID}.choice`}
        />
      )}
      {device.choice === 'custom' ? <CustomSize device={device} testID={`${testID}.size`} /> : null}
      <Text style={repairStyles.muted}>{tn('repair.paper.phoneHint')}</Text>
      {printing === undefined ? null : (
        <View style={styles.test}>
          <Button
            label={tn('repair.testPage.print')}
            variant="secondary"
            size="compact"
            busy={runner.busy}
            onPress={() => void runner.run(() => outputTestPage(runtime, printing, PHONE_PAPERS))}
            testID={`${testID}.test`}
          />
        </View>
      )}
      <ActionErrorBanner
        errorCode={runner.errorCode}
        onDismiss={runner.clearError}
        testID={`${testID}.error`}
      />
    </View>
  );
}

/** The typed size, saved as it is typed. A phone prints cut sheets, never tractor-feed. */
function CustomSize({
  device,
  testID,
}: {
  readonly device: DevicePaper;
  readonly testID: string;
}): React.JSX.Element {
  const form = useCustomPaperForm(device);
  return (
    <View style={styles.column}>
      <View style={styles.size}>
        <View style={styles.sizeField}>
          <TextInput
            label={tn('repair.print.paperWidth')}
            value={form.width}
            onChangeText={form.setWidth}
            onBlur={form.leave}
            onSubmitEditing={form.leave}
            keyboardType="number-pad"
            maxLength={3}
            testID={`${testID}.width`}
          />
        </View>
        <View style={styles.sizeField}>
          <TextInput
            label={tn('repair.print.paperHeight')}
            value={form.height}
            onChangeText={form.setHeight}
            onBlur={form.leave}
            onSubmitEditing={form.leave}
            keyboardType="number-pad"
            maxLength={3}
            testID={`${testID}.height`}
          />
        </View>
      </View>
      {/* The range, red while the typed size is outside it and so not saved. */}
      <Text
        style={[repairStyles.muted, form.invalid ? styles.invalid : null]}
        testID={`${testID}.range`}
      >
        {paperRangeHint()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  size: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  sizeField: { flex: 1 },
  invalid: { color: color.danger },
  column: { gap: space.md },
  test: { alignSelf: 'flex-start' },
});
