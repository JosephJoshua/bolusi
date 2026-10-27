/**
 * PrintStep — print a slip, or send it as a PDF (the customer's WhatsApp, a printer elsewhere).
 * The user picks the slip when there are two and the paper this device prints on; the page is built
 * from the ticket as it reads at that moment, then logged so the next print says "Cetak ulang".
 */
import { PAPER_PRESETS } from '@bolusi/core';
import { ConfirmSheet, SegmentedControl, color, space, type } from '@bolusi/ui';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { SlipKind } from '../constants.js';
import { printableSlips } from '../flows.js';
import { tn, type RepairKey } from '../i18n.js';
import { outputSlip } from '../slip-output.js';
import type { TicketDetailRow } from '../queries.js';
import { useActionRunner } from '../../screen-kit/index.js';
import { FlowScreen, Section, repairStyles, type RepairChrome } from './parts.js';
import { useRepairRuntime, type RepairPrinting } from '../runtime.js';

/** A phone prints on ordinary paper through the system dialog; dot-matrix forms are the PC's. */
const PHONE_PAPERS = ['a4', 'a5'] as const;
type PhonePaper = (typeof PHONE_PAPERS)[number];

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
  const [paper, setPaper] = useState<PhonePaper>('a4');
  // The print dialog could not say whether it printed: ask before logging it, so a cancelled first
  // print does not make the real first slip read "Cetak ulang".
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let live = true;
    void printing.readPaper().then((saved) => {
      if (live && saved !== null && isPhonePaper(saved.preset)) setPaper(saved.preset);
    });
    return () => {
      live = false;
    };
  }, [printing]);

  const output = (how: 'print' | 'share'): void => {
    void runner
      .run(() => outputSlip(runtime, printing, ticket, slip, PAPER_PRESETS[paper], how))
      .then((outcome) => {
        if (outcome === 'unconfirmed') setAsking(true);
        else if (outcome === 'done')
          onDone(how === 'print' ? 'repair.done.printed' : 'repair.done.shared');
      });
  };

  const confirmPrinted = (): void => {
    setAsking(false);
    void runner
      .run(() => runtime.run('recordSlipPrinted', { ticketId: ticket.id, slip }))
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
          {printed === 0 ? null : (
            <Text style={styles.aboutText} testID={`${testID}.reprint`}>
              {tn('repair.print.reprint', { count: printed })}
            </Text>
          )}
        </View>
      </Section>
      <Section title={tn('repair.print.paper')} testID={`${testID}.paper`}>
        <View>
          <SegmentedControl
            options={PHONE_PAPERS.map((value) => ({
              value,
              label: tn(value === 'a4' ? 'repair.print.paperA4' : 'repair.print.paperA5'),
            }))}
            value={paper}
            onChange={setPaper}
            size="compact"
            testID={`${testID}.paperChoice`}
          />
        </View>
      </Section>
    </FlowScreen>
  );
}

function isPhonePaper(preset: string): preset is PhonePaper {
  return (PHONE_PAPERS as readonly string[]).includes(preset);
}

const styles = StyleSheet.create({
  // What the chosen slip is, a little apart from the choice so it does not read as its label.
  about: { marginTop: space.sm, gap: space.xs },
  aboutText: { ...type.bodySm, color: color.textMuted },
});
