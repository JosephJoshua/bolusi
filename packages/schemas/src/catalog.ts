// The phone catalog's wire shapes (GET /v1/catalog/phones): crawled phone models a device keeps
// for offline model search. Photos are fetched one at a time, only when shown.
import { z } from 'zod';

export const PHONE_MODEL_KINDS = ['phone', 'tablet', 'watch'] as const;
export const zPhoneModelKind = z.enum(PHONE_MODEL_KINDS);
export type PhoneModelKind = z.infer<typeof zPhoneModelKind>;

/** Rows per page; a first download of ~13k models is a handful of pages. */
export const PHONE_CATALOG_PAGE_LIMIT = 2000;

export const zPhoneCatalogQuery = z.strictObject({
  /** The last revision the device holds; 0 for none. */
  after: z.coerce.number().int().min(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PHONE_CATALOG_PAGE_LIMIT)
    .default(PHONE_CATALOG_PAGE_LIMIT),
});
export type PhoneCatalogQuery = z.infer<typeof zPhoneCatalogQuery>;

/**
 * The specs kept from a model's GSMArena page, as GSMArena words them (English, trimmed to the
 * useful part): what the counter needs to tell variants apart and what a technician needs before
 * opening the phone. Each is absent when the page does not say.
 */
export const PHONE_SPEC_KEYS = [
  'displayType',
  'displaySize',
  'displayResolution',
  'os',
  'chipset',
  'internalMemory',
  'cardSlot',
  'battery',
  'charging',
  'usb',
  'sim',
  'colors',
] as const;
export type PhoneSpecKey = (typeof PHONE_SPEC_KEYS)[number];

/** Longest spec text kept; GSMArena's longest useful cells are a few lines. */
export const PHONE_SPEC_MAX_LENGTH = 300;

export const zPhoneSpecs = z.partialRecord(
  z.enum(PHONE_SPEC_KEYS),
  z.string().min(1).max(PHONE_SPEC_MAX_LENGTH),
);
export type PhoneSpecs = Partial<Record<PhoneSpecKey, string>>;

export const zPhoneModel = z.strictObject({
  id: z.number().int().positive(),
  brand: z.string().min(1),
  name: z.string().min(1),
  kind: zPhoneModelKind,
  announcedYear: z.number().int().nullable(),
  /** Comma-separated maker codes, '' when unknown. */
  modelCodes: z.string(),
  /** Null when there is no photo; otherwise the photo's hash, checked after download. */
  photoSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  specs: zPhoneSpecs,
  revision: z.number().int().positive(),
});
export type PhoneModel = z.infer<typeof zPhoneModel>;

export const zPhoneCatalogPage = z.strictObject({
  models: z.array(zPhoneModel),
  /** True when more rows follow this page. */
  more: z.boolean(),
});
export type PhoneCatalogPage = z.infer<typeof zPhoneCatalogPage>;
