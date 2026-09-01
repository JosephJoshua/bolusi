/**
 * SyncChip announces the label for its OWN state (design-system §6.3/§6.4; task 144 item 4).
 *
 * THE BUG THIS GUARDS: every caller used to hand the chip ONE label — `sync.status.lastSynced` —
 * for every state, so a screen-reader user heard "last connected 4 min ago" whether the chip read
 * `synced` (fine) or `attention` (a rejected op). Colour/dot distinguished the states for a sighted
 * user; the label did not, for anyone else. The chip now takes a label PER state and announces the
 * one for its current `state`.
 *
 * WHY THIS IS A REAL FALSIFICATION, not a tautology: every state gets a DISTINCT label, so a chip
 * that hardcoded any single entry (`accessibilityLabels.synced`, the old state-invariant behaviour)
 * would announce the wrong string for the other four states and RED every mismatched row below.
 * Falsified per §2.11: pinning the render to `accessibilityLabels.synced` reds `pending`, `syncing`,
 * `offline`, `attention`; restoring `accessibilityLabels[state]` greens all five.
 */
import { describe, expect, test, vi } from 'vitest';

import { SyncChip, type SyncChipState } from '../src/shell/SyncChip.js';
import { render } from './render.js';

/** One distinct label per state — sentinel prefixes so a wrong-state announce is unmistakable. */
const LABELS: Record<SyncChipState, string> = {
  synced: 'label-synced',
  pending: 'label-pending',
  syncing: 'label-syncing',
  offline: 'label-offline',
  attention: 'label-attention',
};

const STATES = Object.keys(LABELS) as readonly SyncChipState[];

describe('SyncChip a11y label derives from state (§6.3/§6.4)', () => {
  test.each(STATES)('state=%s announces its own entry', (state) => {
    const r = render(<SyncChip state={state} accessibilityLabels={LABELS} onPress={vi.fn()} />);
    expect(r.get('ui.syncChip').props['accessibilityLabel']).toBe(LABELS[state]);
  });

  test('two states of the SAME map announce different labels — state-invariance cannot pass this', () => {
    const synced = render(
      <SyncChip state="synced" accessibilityLabels={LABELS} onPress={vi.fn()} />,
    );
    const attention = render(
      <SyncChip state="attention" accessibilityLabels={LABELS} onPress={vi.fn()} />,
    );
    const syncedLabel = synced.get('ui.syncChip').props['accessibilityLabel'];
    const attentionLabel = attention.get('ui.syncChip').props['accessibilityLabel'];
    expect(syncedLabel).toBe(LABELS.synced);
    expect(attentionLabel).toBe(LABELS.attention);
    expect(syncedLabel).not.toBe(attentionLabel);
  });
});
