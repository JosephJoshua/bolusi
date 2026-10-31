// The header chip's screen-reader label for the `synced` state.
import { initI18n, t } from '@bolusi/i18n';
import { beforeAll, describe, expect, test } from 'vitest';

import { syncChipAccessibilityLabels } from './chip-a11y.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
});

describe('syncChipAccessibilityLabels', () => {
  test('without a last-sync time, synced says everything was sent (never a dangling "Terakhir terhubung ")', () => {
    const labels = syncChipAccessibilityLabels({ pendingCount: 0 });
    expect(labels.synced).toBe(t('sync.status.upToDate'));
    expect(syncChipAccessibilityLabels({ relative: '', pendingCount: 0 }).synced).toBe(
      t('sync.status.upToDate'),
    );
  });

  test('with a last-sync time, synced says when', () => {
    expect(syncChipAccessibilityLabels({ relative: '4 menit lalu', pendingCount: 0 }).synced).toBe(
      t('sync.status.lastSynced', { relative: '4 menit lalu' }),
    );
  });

  test('attention says something needs a look, never "rejected": an update needed rejects nothing', () => {
    const attention = syncChipAccessibilityLabels({ pendingCount: 0 }).attention;
    expect(attention).toBe(t('sync.status.titleAttention'));
    expect(attention).not.toBe(t('sync.chip.rejected'));
  });
});
