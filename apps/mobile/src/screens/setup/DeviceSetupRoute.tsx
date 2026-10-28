/**
 * The new-phone setup with the repair module's paper step and the store basics still missing: binds
 * the repair runtime so the paper choice and its test page are the same ones Settings shows. Without
 * repair there is no paper step and no store basics.
 */
import {
  PHONE_PAPERS,
  PaperChoice,
  RepairRuntimeProvider,
  StoreBasicsList,
  paperLabel,
  useDevicePaper,
  type RepairRuntime,
} from '@bolusi/modules/repair/screens';

import { DeviceSetupScreen, type DeviceSetupScreenProps } from './DeviceSetupScreen.js';

type RouteProps = Omit<DeviceSetupScreenProps, 'paper' | 'basics'> & {
  /** Opens the setting that fills a missing store basic. */
  readonly onOpenSetting: (setting: 'printSettings' | 'paymentMethods') => void;
};

export function DeviceSetupRoute({
  repair,
  onOpenSetting,
  ...props
}: RouteProps & {
  readonly repair: RepairRuntime | undefined;
}): React.JSX.Element {
  if (repair === undefined) return <DeviceSetupScreen {...props} />;
  return (
    <RepairRuntimeProvider runtime={repair}>
      <WithPaper repair={repair} onOpenSetting={onOpenSetting} {...props} />
    </RepairRuntimeProvider>
  );
}

function WithPaper({
  repair,
  onOpenSetting,
  ...props
}: RouteProps & {
  readonly repair: RepairRuntime;
}): React.JSX.Element {
  // One reading for the step and the summary, so a paper picked in the step shows at the end.
  const state = useDevicePaper(repair.printing, PHONE_PAPERS);
  const { paper } = state;
  return (
    <DeviceSetupScreen
      {...props}
      paper={{
        choice: <PaperChoice testID="setup.paper" state={state} />,
        label: paper === null ? null : paperLabel(paper),
      }}
      basics={<StoreBasicsList onOpen={onOpenSetting} testID="setup.basics" />}
    />
  );
}
