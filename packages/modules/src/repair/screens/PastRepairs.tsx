// The customer's other servisan on the phone's servisan page: a warranty return or a regular is
// plain at a glance, and each row opens that servisan.
import { AmountRow, Rows, TextButton, space } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PAST_REPAIRS_SHOWN, pastRepairLine } from '../customer-repairs.js';
import { tn } from '../i18n.js';
import { useCustomerRepairs } from '../runtime.js';
import { Section } from './parts.js';

export function PastRepairs({
  customerId,
  ticketId,
  onOpenTicket,
  testID,
}: {
  readonly customerId: string;
  readonly ticketId: string;
  readonly onOpenTicket?: ((ticketId: string) => void) | undefined;
  readonly testID: string;
}): React.JSX.Element | null {
  const repairs = useCustomerRepairs(customerId, ticketId);
  const [all, setAll] = useState(false);
  // Reference, not a task: nothing shows until there is something to show.
  if (repairs.status !== 'ready' || repairs.data.length === 0) return null;
  const rows = all ? repairs.data : repairs.data.slice(0, PAST_REPAIRS_SHOWN);
  return (
    <Section title={tn('repair.pastRepairs.title')} testID={testID}>
      <Rows>
        {rows.map((row) => {
          const line = pastRepairLine(row);
          return (
            <AmountRow
              key={line.id}
              label={line.device}
              detail={line.detail}
              value={line.amount}
              onPress={onOpenTicket === undefined ? undefined : () => onOpenTicket(line.id)}
              testID={`${testID}.row.${line.id}`}
            />
          );
        })}
      </Rows>
      {rows.length === repairs.data.length ? null : (
        <View style={styles.more}>
          <TextButton
            label={tn('repair.pastRepairs.showAll', { count: repairs.data.length })}
            onPress={() => setAll(true)}
            testID={`${testID}.showAll`}
          />
        </View>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  more: { marginTop: space.sm, alignItems: 'flex-start' },
});
