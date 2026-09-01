// The header chip's screen-reader label, ONE per state (design-system §6.3/§6.4; task 144 item 4).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// `SyncChip` is presentational and — by the 08-stack §3.3 boundary — `@bolusi/ui` never calls `t()`;
// it takes already-localized strings. Every caller used to hand it ONE label,
// `t('sync.status.lastSynced', …)`, for EVERY state, so a screen-reader user heard "Terakhir
// terhubung 4 menit lalu" whether the chip read `synced` or `attention` — the colour/dot a sighted
// user sees was invisible to them (§6.3: colour is never the only signal). The chip now takes a label
// PER state and announces the one for its own `state` (owner ruling "SyncChip derives a11y"); this
// builds that five-entry map ONCE so it is not copied into the seven call sites (§2.8).
//
// It mirrors `SYNC_TITLE_KEY` (model.ts) — the same state→key idea — but is a `t`-consuming function
// rather than a bare key map, because two states carry interpolation args (`synced`'s relative time,
// `pending`'s count) that a uniform `t(KEY[state])` cannot supply. `model.ts` stays `t`-free; this is
// the one file in the sync-status view that localizes, keeping translation in `apps/mobile`.
import { t } from '@bolusi/i18n';

import type { SyncChipState } from './model.js';

export interface SyncChipLabelInput {
  /** `synced` only — the humanized "last connected" relative time. Empty ⇒ no suffix. */
  readonly relative?: string;
  /**
   * The count of `local` ops the `pending` chip also shows numerically. REQUIRED, never defaulted: a
   * missing count used to fall back to 0, so a caller that forgot to thread it announced "0 perubahan
   * belum terkirim" (0 unsent) on a chip that is `pending` precisely because ops ARE unsent — a false
   * statement on the one channel §6.3/§6.4 says must carry the state (the task-144 review found three
   * screens doing exactly this). Requiring it turns that silent 0 into a compile error at every call
   * site. A caller whose chip can never be `pending` (the enrollment chip is always `offline`) passes
   * 0 explicitly; its inert `pending` entry is built but never announced.
   */
  readonly pendingCount: number;
}

/**
 * The already-localized accessibility label for each `SyncChipState`, ready to hand `SyncChip` as its
 * `accessibilityLabels` prop. The chip picks the entry for its current state, so the label always
 * matches what the icon/dot shows — never the state-invariant "last connected" of the old single prop.
 */
export function syncChipAccessibilityLabels(
  input: SyncChipLabelInput,
): Record<SyncChipState, string> {
  return {
    synced: t('sync.status.lastSynced', { relative: input.relative ?? '' }),
    pending: t('sync.status.pending', { count: input.pendingCount }),
    syncing: t('sync.status.syncing'),
    offline: t('sync.status.offline'),
    attention: t('sync.chip.rejected'),
  };
}
