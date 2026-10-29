/**
 * PaperScreen — the paper this phone prints slips on, picked once here instead of at every print,
 * with a test page. It is the phone's own setting, so anyone who prints may change it.
 */
import { tn } from '../i18n.js';
import { PaperChoice } from './PaperChoice.js';
import { FlowScreen, type RepairChrome } from './parts.js';

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
      <PaperChoice testID={testID} />
    </FlowScreen>
  );
}
