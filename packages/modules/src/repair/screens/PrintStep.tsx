/**
 * PrintStep — print a slip, or send it as a PDF (the customer's WhatsApp, a printer elsewhere).
 * The user picks the slip when there are two; the paper is this phone's, set in Settings. The page is
 * built from the ticket as it reads at that moment, then logged so the next print says "Cetak ulang".
 */
import { ConfirmSheet, SegmentedControl, color, space, type } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { SlipKind } from '../constants.js';
import { printableSlips } from '../flows.js';
import { tn, type RepairKey } from '../i18n.js';
import { PHONE_PAPERS, paperLabel, useDevicePaper } from '../paper.js';
import { logSlipPrinted, outputSlip } from '../slip-output.js';
import type { TicketDetailRow } from '../queries.js';
import { useActionRunner } from '../../screen-kit/index.js';
import { FlowScreen, Section, repairStyles, type RepairChrome } from './parts.js';
import { useRepairRuntime, type RepairPrinting } from '../runtime.js';

const SLIP_KEY: Readonly<Record<SlipKind, { title: RepairKey; about: RepairKey }>> = {
  intake: { title: 'repair.print.intake', about: 'repair.print.intakeAbout' },
  handover: { title: 'repair.print.handover', about: 'repair.print.handoverAbout' },
};

export interface PrintStepProps {
  readonly chrome: RepairChrome;
  readonly ticket: TicketDetailRow;
  readonly printing: RepairPrinting;
  /** The slip landed; `notice` says whether it was printed or sent. */
  readonly onDone: (notice: RepairKey) => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

export function PrintStep({
  chrome,
  ticket,
  printing,
  onDone,
  onCancel,
  testID = 'repair.print',
}: PrintStepProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const slips = printableSlips(ticket);
  // Once the phone is ready, the bill is what the counter is likeliest to print.
  const [slip, setSlip] = useState<SlipKind>(slips[slips.length - 1]!);
  const { paper } = useDevicePaper(printing, PHONE_PAPERS);
  // The print dialog could not say whether it printed: ask before logging it, so a cancelled first
  // print does not make the real first slip read "Cetak ulang".
  const [asking, setAsking] = useState(false);

  const output = (how: 'print' | 'share'): void => {
    void runner
      .run(() => outputSlip(runtime, printing, ticket, slip, PHONE_PAPERS, how))
      .then((outcome) => {
        if (outcome === 'unconfirmed') setAsking(true);
        else if (outcome === 'done')
          onDone(how === 'print' ? 'repair.done.printed' : 'repair.done.shared');
      });
  };

  const confirmPrinted = (): void => {
    setAsking(false);
    void runner
      .run(() => logSlipPrinted(runtime, ticket.id, slip))
      .then((result) => {
        if (result !== undefined) onDone('repair.done.printed');
      });
  };

  const printed = ticket.slipPrints[slip];
  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.print.title')}
      onBack={onCancel}
      primaryLabel={tn('repair.print.print')}
      onPrimary={() => output('print')}
      secondary={{
        label: tn('repair.print.share'),
        onPress: () => output('share'),
        disabled: runner.busy,
        testID: `${testID}.share`,
      }}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      overlay={
        asking ? (
          <ConfirmSheet
            title={tn('repair.print.askTitle')}
            message={tn('repair.print.askMessage')}
            confirmLabel={tn('repair.print.askYes')}
            onConfirm={confirmPrinted}
            tone="primary"
            cancelLabel={tn('repair.print.askNo')}
            onCancel={() => setAsking(false)}
            testID={`${testID}.ask`}
          />
        ) : null
      }
      testID={testID}
    >
      <Section first title={tn('repair.print.slip')} testID={`${testID}.slipChoice`}>
        {slips.length > 1 ? (
          <SegmentedControl
            options={slips.map((value) => ({ value, label: tn(SLIP_KEY[value].title) }))}
            value={slip}
            onChange={setSlip}
            size="compact"
            testID={`${testID}.slip`}
          />
        ) : (
          <Text style={repairStyles.body} testID={`${testID}.slipTitle`}>
            {tn(SLIP_KEY[slip].title)}
          </Text>
        )}
        <View style={styles.about}>
          <Text style={styles.aboutText} testID={`${testID}.about`}>
            {tn(SLIP_KEY[slip].about)}
          </Text>
          {paper === null ? null : (
            <Text style={styles.aboutText} testID={`${testID}.paper`}>
              {tn('repair.print.onPaper', { paper: paperLabel(paper) })}
            </Text>
          )}
          {printed === 0 ? null : (
            <Text style={styles.aboutText} testID={`${testID}.reprint`}>
              {tn('repair.print.reprint', { count: printed })}
            </Text>
          )}
        </View>
      </Section>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  // What the chosen slip is, a little apart from the choice so it does not read as its label.
  about: { marginTop: space.sm, gap: space.xs },
  aboutText: { ...type.bodySm, color: color.textMuted },
});
