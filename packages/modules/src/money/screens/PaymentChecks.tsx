/**
 * Cocokkan mutasi on a phone: an owner goes down the transfer, QRIS and EDC payments the counter
 * took by hand, beside the bank statement, and answers each one: "Cocok", or "Tidak ada di mutasi",
 * which keeps it on the list, flagged with who took it, until it turns up or is cancelled.
 */
import { Amount, Button, EmptyState, color, space, type, Text } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useActionRunner } from '../../screen-kit/index.js';
import { FlowScreen, QueryView, type ScreenChrome } from '../../screen-kit/screens/views.js';

import { tm } from '../i18n.js';
import { CHECK_ANSWER_KEY, checkLine, usePaymentChecks } from '../payment-checks.js';
import type { MoneyEntryRow } from '../queries.js';
import { useMoneyRuntime } from '../runtime.js';
import type { PaymentCheckOutcome } from '../constants.js';

export interface PaymentChecksStepProps {
  readonly chrome: ScreenChrome;
  readonly onBack: () => void;
  readonly testID?: string | undefined;
}

export function PaymentChecksStep({
  chrome,
  onBack,
  testID = 'money.checks',
}: PaymentChecksStepProps): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const [pages, setPages] = useState(1);
  const [nonce, setNonce] = useState(0);
  const checks = usePaymentChecks(pages, nonce);
  // The payment being answered: its buttons wait, the others stay usable.
  const [answering, setAnswering] = useState<string | null>(null);

  const answer = (entry: MoneyEntryRow, outcome: PaymentCheckOutcome): void => {
    if (answering !== null) return;
    setAnswering(entry.id);
    void runner
      .run(() => runtime.run('checkPayment', { entryId: entry.id, outcome }))
      .finally(() => setAnswering(null));
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tm('money.checks.title')}
      onBack={onBack}
      busy={false}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <QueryView
        query={checks}
        onBack={onBack}
        onRetry={() => setNonce((n) => n + 1)}
        testID={testID}
      >
        {({ rows, more, customers, accounts }) =>
          rows.length === 0 ? (
            <EmptyState title={tm('money.checks.none')} testID={`${testID}.empty`} />
          ) : (
            <View>
              <Text style={styles.hint}>{tm('money.checks.hint')}</Text>
              {rows.map((entry) => {
                const line = checkLine(
                  entry,
                  accounts,
                  entry.documentId === null ? null : (customers.get(entry.documentId) ?? null),
                );
                return (
                  <View key={entry.id} style={styles.item} testID={`${testID}.entry.${entry.id}`}>
                    <View style={styles.head}>
                      <Text style={styles.method}>{line.method}</Text>
                      <Amount
                        value={entry.amount}
                        size="strong"
                        testID={`${testID}.entry.${entry.id}.amount`}
                      />
                    </View>
                    <Text style={styles.detail}>{line.details.join(' · ')}</Text>
                    {line.missing === null ? null : (
                      <Text style={styles.missing} testID={`${testID}.entry.${entry.id}.missing`}>
                        {line.missing}
                      </Text>
                    )}
                    {/* Two answers to one question, the same size side by side. */}
                    <View style={styles.answers}>
                      {line.answers.map((outcome) => (
                        <View key={outcome} style={styles.answer}>
                          <Button
                            label={tm(CHECK_ANSWER_KEY[outcome])}
                            // Every row has its answers: none is filled, so nothing outranks the rest.
                            variant="secondary"
                            size="compact"
                            busy={answering === entry.id}
                            disabled={answering !== null && answering !== entry.id}
                            onPress={() => answer(entry, outcome)}
                            testID={`${testID}.entry.${entry.id}.${outcome}`}
                          />
                        </View>
                      ))}
                    </View>
                  </View>
                );
              })}
              {more ? (
                <View style={styles.more}>
                  <Button
                    label={tm('money.history.more')}
                    variant="secondary"
                    onPress={() => setPages((n) => n + 1)}
                    testID={`${testID}.more`}
                  />
                </View>
              ) : null}
            </View>
          )
        }
      </QueryView>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  hint: { ...type.bodySm, color: color.textMuted, marginBottom: space.sm },
  item: {
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  method: { ...type.bodyBold, color: color.text, flex: 1 },
  detail: { ...type.caption, color: color.textMuted, marginTop: space.xs },
  missing: { ...type.bodySm, color: color.danger, marginTop: space.xs },
  answers: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  answer: { flexGrow: 1, flexBasis: 140 },
  more: { marginTop: space.lg },
});
