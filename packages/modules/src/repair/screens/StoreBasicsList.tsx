/**
 * StoreBasicsList — what the store still lacks (store-basics.ts), each row opening the setting that
 * fills it. Nothing when nothing is missing or it is still loading.
 */
import { Icon, ListRow, color, size, type IconName } from '@bolusi/ui';

import { tn } from '../i18n.js';
import {
  STORE_BASIC_KEY,
  STORE_BASIC_SETTING,
  useMissingStoreBasics,
  type StoreBasic,
} from '../store-basics.js';
import { Section } from './parts.js';

const ICON: Readonly<Record<StoreBasic, IconName>> = {
  slipHeader: 'store',
  logo: 'photos',
  terms: 'list',
  paymentMethods: 'paymentMethods',
};

export function StoreBasicsList({
  onOpen,
  testID,
}: {
  readonly onOpen: (setting: (typeof STORE_BASIC_SETTING)[StoreBasic]) => void;
  readonly testID: string;
}): React.JSX.Element | null {
  const missing = useMissingStoreBasics();
  if (missing === null || missing.length === 0) return null;
  return (
    <Section title={tn('repair.basics.title')} testID={testID}>
      {missing.map((basic) => (
        <ListRow
          key={basic}
          leading={<Icon name={ICON[basic]} size={size.iconInline} color={color.textMuted} />}
          primaryText={tn(STORE_BASIC_KEY[basic].title)}
          secondaryText={tn(STORE_BASIC_KEY[basic].summary)}
          onPress={() => onOpen(STORE_BASIC_SETTING[basic])}
          showChevron
          testID={`${testID}.${basic}`}
        />
      ))}
    </Section>
  );
}
