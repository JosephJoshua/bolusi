// Sync sub-router (api/00 §1; wire protocol api/01-sync — task 16). The production middleware chain
// (bearerAuth → per-device limit → bodyLimit 1 MiB → gzip 10 MiB → zValidator) is wired at the app
// level (app.ts) and runs against these mounts. The handlers delegate to the push/pull modules; the
// router stays a CHAINED definition so `AppType` RPC inference (api/00 §14) keeps working.
import { Hono } from 'hono';

import { DEFAULT_KDF_PARAMS, utf8ToBytes, verifyPinAgainst, type PinVerifier } from '@bolusi/core';
import {
  PERSON_SESSION_HEADER,
  zPersonSessionRequest,
  zPullRequest,
  zPushRequest,
  type PersonSessionResponse,
  type PullResponse,
  type PushResponse,
} from '@bolusi/schemas';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import {
  endPersonSession,
  mintPersonSession,
  personOfSession,
  usableOnDevice,
} from '../auth/person-sessions.js';
import { ApiError } from '../errors.js';
import { toVerifier } from '../identity/bundle.js';
import { enforce, IDENTITY_LIMITS } from '../identity/rate-limits.js';
import { zJson } from '../middleware/validator-hook.js';
import { personExtraReadSet } from '../sync/read-set.js';
import type { TenantDb } from '@bolusi/db-server';
import { runPull } from '../sync/pull.js';
import { runPush } from '../sync/push.js';

/** The person a device was set up for, or null for a shared store device. */
async function personalUserOf(db: TenantDb, deviceId: string): Promise<string | null> {
  const row = await db
    .selectFrom('devices')
    .select(['personalUserId'])
    .where('id', '=', deviceId)
    .executeTakeFirst();
  return row?.personalUserId ?? null;
}

/** A verifier no PIN matches, at the default cost, checked when the person cannot sign in here. */
const DECOY_PIN_VERIFIER: PinVerifier = {
  algorithm: 'argon2id',
  saltB64: Buffer.alloc(16, 7).toString('base64'),
  mKiB: DEFAULT_KDF_PARAMS.memoryCost,
  t: DEFAULT_KDF_PARAMS.timeCost,
  p: 1,
  hashB64: Buffer.alloc(32).toString('base64'),
  asOf: { timestamp: 0, deviceId: '00000000-0000-4000-8000-000000000000', seq: 0 },
};

export function createSyncRouter(deps: ServerDeps) {
  return (
    new Hono<AppEnv>()
      .post('/push', zJson(zPushRequest), async (c) => {
        deps.onStub?.('sync.push');
        const device = c.get('device');
        const body: PushResponse = await runPush(
          {
            forTenant: deps.forTenant,
            tenantQueue: deps.tenantPushQueue,
            crypto: deps.serverCrypto,
            now: deps.now,
            newId: deps.newOpLogId,
            registry: deps.opRegistry,
            projections: deps.projections,
            pokeHub: deps.pokeHub,
            pushDelivery: deps.pushDelivery,
            deliveryDispatcher: deps.deliveryDispatcher,
            ...(deps.detectConflicts === undefined
              ? {}
              : { detectConflicts: deps.detectConflicts }),
            ...(deps.onConflictSurfaced === undefined
              ? {}
              : { onConflictSurfaced: deps.onConflictSurfaced }),
            ...(deps.onDeviceAnomaly === undefined
              ? {}
              : { onDeviceAnomaly: deps.onDeviceAnomaly }),
          },
          { deviceId: device.deviceId, tenantId: device.tenantId },
          c.req.valid('json'),
        );
        return c.json(body);
      })
      .post('/pull', zJson(zPullRequest), async (c) => {
        deps.onStub?.('sync.pull');
        const device = c.get('device');
        const request = c.req.valid('json');
        const identity = {
          deviceId: device.deviceId,
          tenantId: device.tenantId,
          storeId: device.storeId,
        };
        // A person pull needs the person's session token; a device pull must not carry one, so a
        // mixed-up client can never read a person's extras as the device's own (or the reverse).
        const token = c.req.header(PERSON_SESSION_HEADER);
        if ((request.person === true) !== (token !== undefined)) {
          throw new ApiError('PERSON_SESSION_INVALID');
        }
        let personUserId: string | undefined;
        if (token !== undefined) {
          const person = await deps.forTenant(device.tenantId, (db) =>
            personOfSession(db, { token, device: identity, now: deps.now() }),
          );
          if (person === null) throw new ApiError('PERSON_SESSION_INVALID');
          personUserId = person;
        }
        const body: PullResponse = await runPull(
          { forTenant: deps.forTenant, now: deps.now, readScope: deps.readScope },
          personUserId === undefined ? identity : { ...identity, personUserId },
          request,
        );
        return c.json(body);
      })
      // A person signing in on this device proves themselves to the server with their PIN, which the
      // server checks against its own verifier under its own lockout. The session that comes back is
      // what a person pull reads with. Wrong PIN, unknown person, a person not working here, or one
      // without a PIN all answer the same.
      .post('/person-session', zJson(zPersonSessionRequest), async (c) => {
        const device = c.get('device');
        const body = c.req.valid('json');
        const t = deps.now();
        enforce(
          deps.identityRateStore.hit(
            `person-pin-device:${device.deviceId}`,
            IDENTITY_LIMITS.personPinPerDevice.limit,
            IDENTITY_LIMITS.personPinPerDevice.windowMs,
            t,
          ),
        );
        // A failure slot is reserved before the first await and handed back on success, as login
        // does, so concurrent wrong guesses cannot all pass the check.
        const failKey = `person-pin-fail:${device.deviceId}:${body.userId}`;
        enforce(
          deps.identityRateStore.hit(
            failKey,
            IDENTITY_LIMITS.personPinFailPerUserDevice.limit,
            IDENTITY_LIMITS.personPinFailPerUserDevice.windowMs,
            t,
          ),
        );
        const verifierRow = await deps.forTenant(device.tenantId, async (db) => {
          if (!(await usableOnDevice(db, device, body.userId))) return undefined;
          // Someone's own phone is theirs alone: nobody else signs in there (personal-devices.ts).
          const personal = await personalUserOf(db, device.deviceId);
          if (personal !== null && personal !== body.userId) return undefined;
          return db
            .selectFrom('userPinVerifiers')
            .select(['salt', 'params', 'hash', 'asOfTimestamp', 'asOfDeviceId', 'asOfSeq'])
            .where('userId', '=', body.userId)
            .executeTakeFirst();
        });
        // A person who cannot sign in here still costs one PIN check, so the answer's timing does
        // not tell who works at this store.
        const checked = await verifyPinAgainst(
          deps.serverCrypto,
          verifierRow === undefined ? DECOY_PIN_VERIFIER : toVerifier(verifierRow),
          utf8ToBytes(body.pin),
        );
        const matched = verifierRow !== undefined && checked;
        if (!matched) throw new ApiError('AUTH_INVALID_CREDENTIALS');
        deps.identityRateStore.refund(
          failKey,
          IDENTITY_LIMITS.personPinFailPerUserDevice.windowMs,
          t,
        );
        const result: PersonSessionResponse = await deps.forTenant(device.tenantId, async (db) => {
          const session = await mintPersonSession(db, {
            tenantId: device.tenantId,
            deviceId: device.deviceId,
            userId: body.userId,
            now: t,
          });
          const readDevice = {
            storeId: device.storeId,
            personalUserId: await personalUserOf(db, device.deviceId),
          };
          const readSet = await personExtraReadSet(
            db,
            device.tenantId,
            readDevice,
            body.userId,
            deps.readScope,
          );
          return { token: session.token, expiresAt: session.expiresAt, readSet: [...readSet] };
        });
        return c.json(result);
      })
      .delete('/person-session', async (c) => {
        const device = c.get('device');
        const token = c.req.header(PERSON_SESSION_HEADER);
        if (token !== undefined) {
          await deps.forTenant(device.tenantId, (db) =>
            endPersonSession(db, { token, deviceId: device.deviceId, now: deps.now() }),
          );
        }
        return c.body(null, 204);
      })
  );
}
