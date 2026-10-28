/**
 * PaperChoice — the paper this phone prints slips on, saved at once, and a test page to check it
 * through the phone's print dialog. Shared by Settings (PaperScreen) and the new-phone setup.
 */
import { Button, SegmentedControl, space } from '@bolusi/ui';
import { StyleSheet, Text, View } from 'react-native';

import { useActionRunner } from '../../screen-kit/index.js';
import { tn } from '../i18n.js';
import { PAPER_KEY, PHONE_PAPERS, useDevicePaper } from '../paper.js';
import { useRepairRuntime } from '../runtime.js';
import { outputTestPage } from '../slip-output.js';
import { ActionErrorBanner, repairStyles } from './parts.js';

export function PaperChoice({
  testID,
  state,
}: {
  readonly testID: string;
  /** The caller's `useDevicePaper`, when it also shows the paper elsewhere; else its own. */
  readonly state?: ReturnType<typeof useDevicePaper> | undefined;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const printing = runtime.printing;
  const own = useDevicePaper(printing, PHONE_PAPERS);
  const [paper, setPaper] = state ?? own;
  const runner = useActionRunner();
  return (
    <View style={styles.column}>
      {paper === null ? null : (
        <SegmentedControl
          options={PHONE_PAPERS.map((value) => ({ value, label: tn(PAPER_KEY[value]) }))}
          value={paper}
          onChange={(next) => void setPaper(next)}
          size="compact"
          testID={`${testID}.choice`}
        />
      )}
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

const styles = StyleSheet.create({
  column: { gap: space.md },
  test: { alignSelf: 'flex-start' },
});
