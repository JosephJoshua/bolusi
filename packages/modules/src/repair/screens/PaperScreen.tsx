/**
 * PaperScreen — the paper this phone prints slips on, picked once here instead of at every print.
 * It is the phone's own setting, so anyone who prints may change it, and a pick saves at once.
 */
import { SegmentedControl } from '@bolusi/ui';
import { Text } from 'react-native';

import { tn } from '../i18n.js';
import { PAPER_KEY, PHONE_PAPERS, useDevicePaper } from '../paper.js';
import { FlowScreen, repairStyles, type RepairChrome } from './parts.js';
import { useRepairRuntime } from '../runtime.js';

export interface PaperScreenProps {
  readonly chrome: RepairChrome;
  readonly onClose: () => void;
  readonly testID?: string | undefined;
}

export function PaperScreen({
  chrome,
  onClose,
  testID = 'repair.paper',
}: PaperScreenProps): React.JSX.Element {
  const [paper, setPaper] = useDevicePaper(useRepairRuntime().printing, PHONE_PAPERS);
  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.paper.title')}
      onBack={onClose}
      busy={false}
      errorCode={null}
      onClearError={() => undefined}
      testID={testID}
    >
      {paper === null ? null : (
        <SegmentedControl
          options={PHONE_PAPERS.map((value) => ({ value, label: tn(PAPER_KEY[value]) }))}
          value={paper}
          onChange={(next) => void setPaper(next)}
          size="compact"
          testID={`${testID}.choice`}
        />
      )}
      <Text style={[repairStyles.muted, repairStyles.gap]}>{tn('repair.paper.phoneHint')}</Text>
    </FlowScreen>
  );
}
