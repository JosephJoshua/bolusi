// Focused guard for `userLocaleChangedApplier` (07-i18n §1.1; task 76).
//
// The fold writes a `Locale` — `'id' | 'en'`, exactly the `z.enum(['id','en'])` payload value it
// carries — NOT an Intl formatting tag. `user_prefs.locale` once declared `DEFAULT 'id-ID'`, which
// is `INTL_LOCALE_TAG.id` and NOT a `Locale`: a decoy no fold could reach (the applier always
// supplies `locale`) that a reader would nonetheless trust. Task 76 dropped that default. These
// tests pin the two facts that made the drop safe:
//   1. the applier writes a real `Locale`, never the Intl tag `'id-ID'`; and
//   2. it ALWAYS supplies `locale` explicitly, so `NOT NULL` holds against a schema with NO default.
//
// The table below is created WITHOUT a column default ON PURPOSE — the post-task-76 shape. An
// insert that succeeds against it proves the applier supplied the value; a default could not have.
// (Falsified per CLAUDE.md §2.11: break the applier to emit `'id-ID'` and test 1 reds on the value;
// break it to omit `locale` and test 2 reds with a NOT NULL violation. Both were observed red.)
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { describe, expect, test } from 'vitest';

import { createClientDialect } from '@bolusi/db-client';
import { SELECTABLE_LOCALES, type SignedOperation } from '@bolusi/schemas';

import { userLocaleChangedApplier } from '../../src/platform/projections/user-prefs.js';
import type { PlatformDatabase } from '../../src/platform/schema.js';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';

/** `INTL_LOCALE_TAG.id` (07-i18n §5) — a formatting tag, NEVER a `Locale`. The value the fold must
 *  never write and no fixture must seed. */
const INTL_TAG = 'id-ID';

const TENANT = '00000000-0000-7000-8000-00000000t001';
const SYSTEM_DEVICE = '00000000-0000-7000-8000-00000000d999';

function localeChangedOp(entityId: string, locale: string, seq: number): SignedOperation {
  return {
    id: `op-${String(seq).padStart(4, '0')}`,
    tenantId: TENANT,
    storeId: null,
    userId: entityId,
    deviceId: SYSTEM_DEVICE,
    seq,
    type: 'platform.user_locale_changed',
    entityType: 'user_pref',
    entityId,
    schemaVersion: 1,
    payload: { locale },
    timestamp: 1_726_000_000_000 + seq,
    location: null,
    source: 'system',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: '0'.repeat(64),
    hash: String(seq).padStart(64, '0'),
    signature: `sig-${seq}`,
  } as SignedOperation;
}

async function openUserPrefsDb(): Promise<{
  db: Kysely<PlatformDatabase>;
  close: () => Promise<void>;
}> {
  const driver = openMemoryDriver();
  const db = new Kysely<PlatformDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  // Post-task-76 shape: `locale` is NOT NULL with NO column default (10-db §9.6 / §8).
  await db.schema
    .createTable('user_prefs')
    .addColumn('user_id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('locale', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'bigint', (c) => c.notNull())
    .execute();
  return {
    db,
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}

async function readLocale(
  db: Kysely<PlatformDatabase>,
  userId: string,
): Promise<string | undefined> {
  const result = await sql<{
    locale: string;
  }>`SELECT locale FROM user_prefs WHERE user_id = ${userId}`.execute(db);
  return result.rows[0]?.locale;
}

describe('userLocaleChangedApplier writes a Locale, never an Intl tag (task 76)', () => {
  test.each(SELECTABLE_LOCALES)(
    'folds payload locale %s verbatim as a real Locale',
    async (locale) => {
      const { db, close } = await openUserPrefsDb();
      try {
        await userLocaleChangedApplier(db, localeChangedOp('user-1', locale, 1));
        const written = await readLocale(db, 'user-1');
        expect(written).toBe(locale);
        expect(SELECTABLE_LOCALES).toContain(written);
        expect(written).not.toBe(INTL_TAG);
      } finally {
        await close();
      }
    },
  );

  test('the insert supplies locale explicitly, so NOT NULL holds with NO column default', async () => {
    const { db, close } = await openUserPrefsDb();
    try {
      // The table has no default; a successful insert proves the applier supplied `locale` itself.
      await expect(
        userLocaleChangedApplier(db, localeChangedOp('user-2', 'en', 2)),
      ).resolves.toBeUndefined();
      expect(await readLocale(db, 'user-2')).toBe('en');
    } finally {
      await close();
    }
  });
});
