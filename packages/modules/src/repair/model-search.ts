// The phone catalog as a search other modules take (the parts list's "fits" picker), and the caption
// a catalog model shows under its name. Plain functions, so the device core binds them without a
// screen.
import type { DeviceModelRow } from './device-models.js';
import { tn } from './i18n.js';
import type { PhoneModelOption } from '../inventory/runtime.js';
import type { RepairRuntime } from './runtime.js';

/** "Samsung · 2024", "Samsung · Tablet · 2024", or "Evercoss · Serviced here before". */
export function modelCaption(row: DeviceModelRow): string {
  const parts = [row.brand];
  if (row.kind === 'tablet') parts.push(tn('repair.device.tablet'));
  if (row.kind === 'watch') parts.push(tn('repair.device.watch'));
  if (row.learned) parts.push(tn('repair.device.servicedBefore'));
  else if (row.announcedYear !== null) parts.push(String(row.announcedYear));
  return parts.join(' · ');
}

/**
 * The phone catalog search as other modules take it (the parts list's "fits" picker): the same
 * models, spellings and captions the intake offers.
 */
export function catalogModelSearch(
  runtime: Pick<RepairRuntime, 'query'>,
): (text: string, limit: number) => Promise<readonly PhoneModelOption[]> {
  return async (text, limit) =>
    (await runtime.query('searchDeviceModels', { text, limit })).rows.map((row) => ({
      key: row.key,
      brand: row.brand,
      model: row.model,
      caption: modelCaption(row),
    }));
}
