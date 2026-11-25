// "Permintaan dibuat…" after asking an owner, the same on the phone and the PC: it stays while the
// request waits and goes once it is answered (or taken back), so it never reads stale.
import { useEffect, useRef } from 'react';

import { ta } from '../approvals/i18n.js';
import type { ApprovalRow } from '../approvals/queries.js';

/**
 * Clears `done` when it is the asked notice and nothing this person asked on the servisan waits
 * any more. It first waits to see the request listed, since the re-read lands after the notice.
 */
export function useClearAskedNotice(
  done: string | null,
  clear: () => void,
  approvals: readonly ApprovalRow[] | undefined,
): void {
  const asked = done === ta('approvals.done.asked');
  const waiting =
    approvals === undefined
      ? undefined
      : approvals.some((row) => row.mine && row.status === 'waiting');
  const seen = useRef(false);
  useEffect(() => {
    if (!asked) {
      seen.current = false;
      return;
    }
    if (waiting === true) seen.current = true;
    else if (waiting === false && seen.current) {
      seen.current = false;
      clear();
    }
  }, [asked, waiting, clear]);
}
