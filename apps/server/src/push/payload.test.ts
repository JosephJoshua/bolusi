// Payload rules + the SEC-RT-03 push-leg audit (api/04-push §4; security-guide §9.2). No real
// transport, no DB — pure composition. Copy is never asserted literally (testing-guide §3.2): locale
// selection is proven by comparing the composer's output to the SAME i18n instance rendered in the
// target locale, and by proving `id` and `en` differ — never by pinning a Bahasa/English sentence.
import { getI18nInstance, initI18n } from '@bolusi/i18n';
import { pushChannelId } from '@bolusi/schemas';
import { beforeAll, describe, expect, test } from 'vitest';

import {
  composeConflict,
  composeDevice,
  composeSync,
  resolveLocale,
  validateComposedPush,
  zComposedPush,
  auditView,
  type ComposedPush,
} from './payload.js';

beforeAll(() => {
  initI18n();
});

const CONFLICT_ID = '018f4e2a-1111-7abc-8def-000000000001';
const DEVICE_ID = '018f4e2a-2222-7abc-8def-000000000002';

/** Serialize what actually goes on the wire: the recipient token + the composed push. */
function wire(push: ComposedPush): string {
  return JSON.stringify({ to: 'ExponentPushToken[x]', ...push });
}

describe('payload shapes (api/04-push §4)', () => {
  test('sync is data-only: category and nothing else — no title, body, route, params, channelId', () => {
    const push = composeSync();
    expect(push).toEqual({ data: { category: 'sync' } });
    expect(Object.keys(push)).toEqual(['data']);
    expect(Object.keys(push.data)).toEqual(['category']);
    expect('title' in push).toBe(false);
    expect('channelId' in push).toBe(false);
  });

  test('conflict carries exactly title, body, data{category,route,params:{conflictId}}, channelId', () => {
    const push = composeConflict(CONFLICT_ID, 'id');
    if (!('title' in push)) throw new Error('expected a visible push');
    expect(new Set(Object.keys(push))).toEqual(new Set(['data', 'title', 'body', 'channelId']));
    expect(push.data).toEqual({
      category: 'conflict',
      route: 'conflicts',
      params: { conflictId: CONFLICT_ID },
    });
    expect(push.channelId).toBe('bolusi.conflict');
    expect(typeof push.title).toBe('string');
    expect(typeof push.body).toBe('string');
  });

  test('device carries exactly route "devices", params {deviceId}, channelId "bolusi.device"', () => {
    const push = composeDevice(DEVICE_ID, 'id');
    if (!('title' in push)) throw new Error('expected a visible push');
    expect(push.data).toEqual({
      category: 'device',
      route: 'devices',
      params: { deviceId: DEVICE_ID },
    });
    expect(push.channelId).toBe('bolusi.device');
  });

  test('channelId is the shared pushChannelId(category) — the ONE scheme the mobile app also uses (task 107)', () => {
    // The value must equal what mobile creates the channel under, byte for byte, or Android drops the
    // notification onto a default channel and silently defeats the per-category mute (api/04-push §5).
    // The server DERIVES it from `@bolusi/schemas`' `pushChannelId`; asserting against that same
    // function proves the server side never re-hardcodes a bare category (the original task-107 bug).
    expect((composeConflict(CONFLICT_ID, 'id') as { channelId: string }).channelId).toBe(
      pushChannelId('conflict'),
    );
    expect((composeDevice(DEVICE_ID, 'id') as { channelId: string }).channelId).toBe(
      pushChannelId('device'),
    );
  });
});

describe('locale fallback matrix (07-i18n §8, api/04 §4)', () => {
  test('resolveLocale: null/absent → id; unknown value → id; valid → itself', () => {
    expect(resolveLocale(undefined)).toBe('id');
    expect(resolveLocale({ locale: 'id-ID' })).toBe('id'); // region tag is not a Locale → fallback
    expect(resolveLocale({ locale: 'fr' })).toBe('id');
    expect(resolveLocale({ locale: 'en' })).toBe('en');
    expect(resolveLocale({ locale: 'id' })).toBe('id');
  });

  test('composition renders the resolved locale — en and id differ, and match the catalog', () => {
    const i18n = getI18nInstance();
    const en = composeConflict(CONFLICT_ID, 'en');
    const id = composeConflict(CONFLICT_ID, 'id');
    if (!('title' in en) || !('title' in id)) throw new Error('expected visible pushes');
    // Proven against the SAME instance in the target locale — not a hardcoded sentence.
    expect(en.title).toBe(i18n.t('push.conflict.title', { lng: 'en' }));
    expect(en.body).toBe(i18n.t('push.conflict.body', { lng: 'en' }));
    expect(id.title).toBe(i18n.t('push.conflict.title', { lng: 'id' }));
    // The whole point of server-side composition: the two locales produce different bytes.
    expect(en.title).not.toBe(id.title);
  });

  test('the compose functions take a resolved Locale, never an Accept-Language header (07-i18n §9)', () => {
    // Structural: composeConflict/composeDevice have arity (id, locale) — no header parameter exists.
    expect(composeConflict.length).toBe(2);
    expect(composeDevice.length).toBe(2);
  });
});

describe('SEC-RT-03 (push leg): payload audit (api/04-push §4; security-guide §9.2)', () => {
  test('SEC-RT-03 (push leg): every composed push validates against the api/04 §4 shape', () => {
    for (const push of [
      composeSync(),
      composeConflict(CONFLICT_ID, 'id'),
      composeConflict(CONFLICT_ID, 'en'),
      composeDevice(DEVICE_ID, 'id'),
      composeDevice(DEVICE_ID, 'en'),
    ]) {
      expect(validateComposedPush(push).success).toBe(true);
    }
  });

  test('SEC-RT-03 (push leg): a payload smuggling a business value (extra key) fails the schema', () => {
    // A note body / amount / customer name would have to enter as an EXTRA key or a wrong-shaped
    // params — the strict discriminated union rejects all of them.
    const smuggleInParams = auditView({
      data: {
        category: 'conflict',
        route: 'conflicts',
        params: { conflictId: CONFLICT_ID, amountIdr: 1_500_000 },
      },
      title: 't',
      body: 'b',
      channelId: 'bolusi.conflict',
    } as unknown as ComposedPush);
    expect(zComposedPush.safeParse(smuggleInParams).success).toBe(false);

    const extraTopLevel = auditView({
      data: { category: 'sync' },
      customerName: 'Budi Santoso',
    } as unknown as ComposedPush);
    expect(zComposedPush.safeParse(extraTopLevel).success).toBe(false);

    const syncWithTitle = auditView({
      data: { category: 'sync' },
      title: 'leaked',
    } as unknown as ComposedPush);
    expect(zComposedPush.safeParse(syncWithTitle).success).toBe(false);
  });

  test("SEC-RT-03 (push leg): business-data ceiling — an entity's distinctive strings never reach the wire", () => {
    // A conflict fixture rich with business data; compose a push FOR it by id only.
    const entity = {
      id: CONFLICT_ID,
      customerName: 'Budi Santoso',
      amountIdr: '1500000',
      noteBody: 'pelanggan minta refund penuh sekarang juga',
    };
    for (const locale of ['id', 'en'] as const) {
      const serialized = wire(composeConflict(entity.id, locale));
      expect(serialized).not.toContain(entity.customerName);
      expect(serialized).not.toContain(entity.amountIdr);
      expect(serialized).not.toContain(entity.noteBody);
      // The only entity-derived value on the wire is the id (a UUID) inside params.
      const push = composeConflict(entity.id, locale) as {
        data: { params: { conflictId: string } };
      };
      expect(Object.keys(push.data.params)).toEqual(['conflictId']);
      expect(push.data.params.conflictId).toBe(entity.id);
    }
  });
});
