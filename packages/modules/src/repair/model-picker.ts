// The phone catalog behind the intake's model field, the same on the phone and the PC: models
// suggested as they are typed, the brand filled in once the catalog surely knows the model, and
// the catalog's way of writing the name kept once the user moves on. Only the drawing differs.
import { useEffect, useState } from 'react';

import { sameDeviceModel, type DeviceModelRow } from './device-models.js';
import { colourChoices, memoryVariants } from './device-specs.js';
import type { IntakeDraft } from './flows.js';
import { tn } from './i18n.js';
import type { PhoneModelOption } from '../inventory/runtime.js';
import { useRepairQuery, type RepairRuntime } from './runtime.js';

/** The catalog model a brand and model name are, when the catalog surely has it (findDeviceModel). */
export function useCatalogModel(brand: string, model: string): DeviceModelRow | null {
  const query = useRepairQuery(
    async (rt) =>
      model.trim() === ''
        ? null
        : ((await rt.query('findDeviceModel', { brand: brand.trim(), model: model.trim() }))
            .rows[0] ?? null),
    `deviceModel:${brand.trim()}\u0000${model.trim()}`,
  );
  return query.status === 'ready' ? query.data : null;
}

/** "Samsung · 2024", "Samsung · Tablet · 2024", or "Evercoss · Serviced here before". */
export function modelCaption(row: DeviceModelRow): string {
  const parts = [row.brand];
  if (row.kind === 'tablet') parts.push(tn('repair.device.tablet'));
  if (row.kind === 'watch') parts.push(tn('repair.device.watch'));
  if (row.learned) parts.push(tn('repair.device.servicedBefore'));
  else if (row.announcedYear !== null) parts.push(String(row.announcedYear));
  return parts.join(' · ');
}

export interface ModelPicker {
  /** The catalog model the fields name, once it surely is one. */
  readonly matched: DeviceModelRow | null;
  /** Models to offer while the typed one is not settled yet; empty otherwise. */
  readonly suggestions: readonly DeviceModelRow[];
  /** The matched model's memory variants and colours, to offer as quick picks. */
  readonly memory: readonly string[];
  readonly colours: readonly string[];
  readonly pick: (row: DeviceModelRow) => void;
  /** On leaving the model field: "samsung a55" becomes the catalog's "Galaxy A55". */
  readonly tidyModel: () => void;
}

export function useModelPicker(
  device: IntakeDraft['device'],
  set: (patch: Partial<IntakeDraft['device']>) => void,
  limit = 5,
): ModelPicker {
  // The brand the picker filled in from the catalog. While the field still holds it, a different
  // catalog model may replace it; once the user types their own brand, it is theirs.
  const [autoBrand, setAutoBrand] = useState<string | null>(null);
  const brand = device.brand.trim();
  const model = device.model.trim();
  const brandIsOurs = brand === '' || device.brand === autoBrand;
  const searchText = (brandIsOurs ? model : `${brand} ${model}`).trim();
  const matched = useCatalogModel(brandIsOurs ? '' : brand, model);
  const found = useRepairQuery(
    async (rt) =>
      model === '' ? [] : (await rt.query('searchDeviceModels', { text: searchText, limit })).rows,
    `deviceModels:${searchText}:${String(limit)}`,
  );

  useEffect(() => {
    if (matched === null || !brandIsOurs || device.brand === matched.brand) return;
    setAutoBrand(matched.brand);
    set({ brand: matched.brand });
    // Only a newly found model fills the brand; `set` and the draft are this render's.
  }, [matched?.key]);

  const rows = found.status === 'ready' ? found.data : [];
  const picked = matched !== null || rows.some((row) => sameDeviceModel(row, { brand, model }));
  return {
    matched,
    suggestions: picked ? [] : rows,
    memory: matched === null ? [] : memoryVariants(matched.specs.internalMemory),
    colours: matched === null ? [] : colourChoices(matched.specs.colors),
    pick: (row) => {
      setAutoBrand(row.brand);
      set({ brand: row.brand, model: row.model });
    },
    tidyModel: () => {
      if (matched === null || (device.model === matched.model && device.brand === matched.brand)) {
        return;
      }
      setAutoBrand(matched.brand);
      set({ brand: matched.brand, model: matched.model });
    },
  };
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
