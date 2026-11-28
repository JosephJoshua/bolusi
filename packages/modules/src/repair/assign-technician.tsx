// Giving a servisan to a technician, the same on the phone and the PC: each technician with how
// many repairs they already hold, so the counter can spread the work. Each app only draws the list.
import { useState } from 'react';

import { useActionRunner } from '../screen-kit/index.js';

import { useRepairQuery, useRepairRuntime } from './runtime.js';

export function useAssignTechnician(
  facts: { readonly ticketId: string; readonly currentTechnicianId: string | null },
  onDone: () => void,
) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const { ticketId, currentTechnicianId } = facts;
  const [reloadNonce, setReloadNonce] = useState(0);
  const technicians = useRepairQuery(
    async (rt) => {
      const [people, loads] = await Promise.all([
        rt.technicians(),
        rt.query('technicianLoads', {}),
      ]);
      const load = new Map(loads.rows.map((row) => [row.technicianId, row.load]));
      return people.map((tech) => ({ ...tech, load: load.get(tech.id) ?? 0 }));
    },
    `technicians:${String(reloadNonce)}`,
  );
  const assign = (technicianId: string): void => {
    if (technicianId === currentTechnicianId) return;
    void runner
      .run(() => runtime.run('assignTechnician', { ticketId, technicianId }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return { runner, technicians, retry: () => setReloadNonce((n) => n + 1), assign };
}
