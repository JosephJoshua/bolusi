// Keeps the device's copy of the phone catalog (client migration 8) current, for offline model
// search at intake (repair device-models.ts).
//
// The catalog is reference data, not ops: it is fetched by revision from GET /v1/catalog/phones,
// a page at a time, each page written with its cursor in one transaction so an interrupted download
// resumes where it stopped. It runs after a successful sync at most every few hours, alongside but
// never inside the sync cycle: a catalog failure must not put sync into backoff or hold its
// progress, and a counter that never got the catalog still takes devices in by typing the model.
// Photos are not downloaded here; they load when a screen shows one (media/phone-photos.ts).
import { readMeta, writeMeta, type ClockPort, type InvalidationBus } from '@bolusi/core';
import type { ClientDb } from '@bolusi/db-client';
import { PHONE_MODELS_TABLE } from '@bolusi/modules/repair';
import { zPhoneCatalogPage, type PhoneModel } from '@bolusi/schemas';

import { toTransportError } from './transport.js';

/** `meta_kv`: the highest catalog revision this device holds. */
export const PHONE_CATALOG_REVISION_KEY = 'phoneCatalogRevision';
/** `meta_kv`: when the device last finished checking for catalog changes. */
export const PHONE_CATALOG_CHECKED_KEY = 'phoneCatalogCheckedAt';

/** The catalog grows by a few models a week; checking twice a day is plenty. */
export const PHONE_CATALOG_CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

export type PhoneCatalogRefreshOutcome = 'not-due' | 'unchanged' | 'updated';

export interface PhoneCatalogRefresher {
  /** Download what changed, if a check is due. Concurrent calls share one download. */
  refreshIfDue(): Promise<PhoneCatalogRefreshOutcome>;
}

export interface PhoneCatalogRefreshConfig {
  readonly baseUrl: string;
  readonly deviceToken: () => Promise<string | null>;
  readonly db: ClientDb;
  /** Told that `phone_models` changed, so the model search reloads its index. */
  readonly invalidation: InvalidationBus;
  readonly clock: ClockPort;
  readonly fetchImpl?: typeof fetch;
}

async function savePage(config: PhoneCatalogRefreshConfig, models: readonly PhoneModel[]) {
  await config.db.transaction(async () => {
    for (const model of models) {
      const specs = JSON.stringify(model.specs);
      await config.db.db
        .insertInto('phoneModels')
        .values({ ...model, specs })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            brand: model.brand,
            name: model.name,
            kind: model.kind,
            announcedYear: model.announcedYear,
            modelCodes: model.modelCodes,
            photoSha256: model.photoSha256,
            specs,
            revision: model.revision,
          }),
        )
        .execute();
    }
    const last = models.reduce((max, model) => Math.max(max, model.revision), 0);
    await writeMeta(config.db.db, PHONE_CATALOG_REVISION_KEY, String(last));
    config.invalidation.emit(new Set([PHONE_MODELS_TABLE]));
  });
}

export function createPhoneCatalogRefresher(
  config: PhoneCatalogRefreshConfig,
): PhoneCatalogRefresher {
  const doFetch = config.fetchImpl ?? fetch;
  let running: Promise<PhoneCatalogRefreshOutcome> | null = null;

  async function run(): Promise<PhoneCatalogRefreshOutcome> {
    const checkedAt = Number((await readMeta(config.db.db, PHONE_CATALOG_CHECKED_KEY)) ?? 0);
    if (config.clock.now() - checkedAt < PHONE_CATALOG_CHECK_EVERY_MS) return 'not-due';
    let outcome: PhoneCatalogRefreshOutcome = 'unchanged';
    for (;;) {
      const token = await config.deviceToken();
      if (token === null) return outcome;
      const after = Number((await readMeta(config.db.db, PHONE_CATALOG_REVISION_KEY)) ?? 0);
      const response = await doFetch(`${config.baseUrl}/v1/catalog/phones?after=${after}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw await toTransportError(response);
      const page = zPhoneCatalogPage.parse(await response.json());
      if (page.models.length > 0) {
        await savePage(config, page.models);
        outcome = 'updated';
      }
      if (!page.more || page.models.length === 0) break;
    }
    await writeMeta(config.db.db, PHONE_CATALOG_CHECKED_KEY, String(config.clock.now()));
    return outcome;
  }

  return {
    refreshIfDue() {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
