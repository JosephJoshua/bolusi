// Changing a servisan's repair types, the same on the phone and the PC. Saving an unchanged pick
// only closes the step. Each app only draws the choices.
import { useState } from 'react';

import { useActionRunner } from '../screen-kit/index.js';

import type { TicketDetailRow } from './queries.js';
import { useRepairRuntime } from './runtime.js';

export function useRepairTypesPick(
  facts: { readonly ticketId: string; readonly current: TicketDetailRow['repairTypes'] },
  done: { readonly onDone: () => void; readonly onUnchanged: () => void },
) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const { ticketId, current } = facts;
  const [picked, setPicked] = useState<readonly string[]>(() => current.map((type) => type.item));
  const changed =
    picked.length !== current.length || picked.some((id, i) => id !== current[i]!.item);
  const submit = (): void => {
    if (!changed) {
      done.onUnchanged();
      return;
    }
    void runner
      .run(() => runtime.run('setRepairTypes', { ticketId, repairTypes: [...picked] }))
      .then((result) => {
        if (result !== undefined) done.onDone();
      });
  };
  return { runner, picked, setPicked, submit };
}
