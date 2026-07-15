// The ctx brand — what actually makes a forged ctx impossible (04-module-contract §5.2).
//
// WHY THIS FILE EXISTS. `execute(command, input, ctx)` takes the ctx as an ARGUMENT, so the brand
// is the only thing standing between "the runtime established this identity" and "the caller says
// so". A review found the brand's own comment asserting a property that did not hold — it claimed
// the symbol was unexported (it was exported) and implied THAT was the protection. The protection
// is object identity. Both claims are now pinned here, because a security property explained only
// in a comment is a claim, and the next person to read it may simplify the check it licenses.
//
// The load-bearing case is `symbol + wrong runtime object → refused`: it is the exact attack the
// old comment implied was impossible for the wrong reason.
import { describe, expect, it } from 'vitest';

import * as publicEntry from '../../src/index.js';
// The internal path — the ONLY way to reach the symbol, which is the point of the first test.
import { CTX_RUNTIME_BRAND, isOwnContext } from '../../src/runtime/ctx.js';

import { expectDomainError, makeCommandSpy, makeRuntimeFixture } from './_fixtures.js';

async function ready(seed: number) {
  const fixture = makeRuntimeFixture(seed);
  await fixture.prime();
  await fixture.enroll();
  return fixture;
}

describe('the brand symbol is not on the package surface (defence in depth)', () => {
  it('is absent from the public entry', () => {
    // `runtime/index.ts` deliberately does not re-export it. Asserted rather than commented: this
    // file's whole reason for existing is that the previous version of that claim was false.
    expect(Object.keys(publicEntry)).not.toContain('CTX_RUNTIME_BRAND');
    expect((publicEntry as Record<string, unknown>).CTX_RUNTIME_BRAND).toBeUndefined();
  });

  it('POSITIVE CONTROL — the ctx helpers ARE exported, so the check above is not vacuous', () => {
    // If `src/index.ts` stopped re-exporting the runtime altogether, the assertion above would
    // pass for the wrong reason (T-14b).
    expect(Object.keys(publicEntry)).toContain('createCommandContext');
    expect(Object.keys(publicEntry)).toContain('isOwnContext');
    expect(Object.keys(publicEntry)).toContain('CommandRuntime');
  });
});

describe('the brand is object identity, not symbol obscurity', () => {
  it('THE ATTACK — holding the symbol does not let a caller forge a ctx', async () => {
    const fixture = await ready(1);
    const command = makeCommandSpy(fixture.log);

    // Assume the worst: the attacker has the symbol (a deep import, a leaked reference, a future
    // refactor that re-exports it). They brand their own object with their own marker.
    const forged = {
      tenantId: fixture.tenantId,
      storeId: fixture.storeId,
      userId: fixture.ownerId,
      deviceId: fixture.deviceId,
      op: (draft: unknown) => draft,
      newId: () => fixture.newId(),
      requirePermission: () => Promise.resolve(),
      query: () => Promise.resolve(undefined),
      [CTX_RUNTIME_BRAND]: {
        runtime: {}, // not this runtime's #brand — and they cannot obtain it
        identity: {
          tenantId: fixture.tenantId,
          storeId: fixture.storeId,
          userId: fixture.ownerId,
          deviceId: fixture.deviceId,
        },
        invocation: { source: 'ui', agentInitiated: false, agentConversationId: null },
      },
    };

    const error = await fixture.runtime
      .execute(command, { title: 't', body: 'b' }, forged as never)
      .catch((e: unknown) => e);

    expectDomainError(error, 'PERMISSION_DENIED');
    expect(command.invocations, 'the symbol buys nothing — no handler runs').toEqual([]);
  });

  it('a mere presence check would pass the forgery the `===` refuses', async () => {
    const fixture = await ready(2);
    const forged = { [CTX_RUNTIME_BRAND]: { runtime: {}, identity: {}, invocation: {} } };

    // This is the simplification the old comment licensed ("the symbol is private, so presence is
    // enough"). It would accept the object above. The real check refuses it. Pinning the contrast
    // is what stops that refactor from looking harmless.
    expect(CTX_RUNTIME_BRAND in forged, 'presence: the forgery LOOKS branded').toBe(true);
    expect(isOwnContext(forged as never, fixture.runtimeBrand), 'identity: refused').toBe(false);
  });

  it('POSITIVE CONTROL — a genuinely minted ctx is accepted (T-14b)', async () => {
    const fixture = await ready(3);
    const ctx = fixture.runtime.createContext(fixture.ownerId);

    expect(isOwnContext(ctx, fixture.runtimeBrand)).toBe(true);
    await expect(
      fixture.runtime.execute(makeCommandSpy(fixture.log), { title: 't', body: 'b' }, ctx),
    ).resolves.toBeDefined();
  });

  it("another runtime's ctx is refused, brand and all", async () => {
    const a = await ready(4);
    const b = await ready(5);
    const bCtx = b.runtime.createContext(b.ownerId);

    // A real, properly-branded ctx — just not THIS runtime's. Same refusal.
    expect(CTX_RUNTIME_BRAND in bCtx).toBe(true);
    expect(isOwnContext(bCtx, a.runtimeBrand)).toBe(false);
  });
});

describe('the minted ctx is immutable, and the decision does not read its fields anyway', () => {
  it('is frozen — reassigning userId throws in strict mode', async () => {
    const fixture = await ready(6);
    const ctx = fixture.runtime.createContext(fixture.staffId);

    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      (ctx as { userId: string }).userId = fixture.ownerId;
    }).toThrow(TypeError);
    expect(ctx.userId).toBe(fixture.staffId);
  });

  it('the identity comes from the binding, so a mutated ctx field could not escalate regardless', async () => {
    const fixture = await ready(7);
    // A hand-built object mirroring a real ctx's binding, but whose PUBLIC userId says `ownerId`
    // while the binding says `staffId` — the "checked against A, written as B" shape. It cannot
    // arise through `createContext` (frozen, one source), so it is constructed here to prove the
    // decision path ignores the public field entirely.
    const real = fixture.runtime.createContext(fixture.staffId);
    const skewed = {
      ...real,
      userId: fixture.ownerId,
      [CTX_RUNTIME_BRAND]: real[CTX_RUNTIME_BRAND],
    };

    // `notes.create` is held by staff (in this store) AND by the owner, so this command succeeds
    // either way — what is being asserted is WHICH identity got stamped.
    await fixture.runtime.execute(
      makeCommandSpy(fixture.log),
      { title: 't', body: 'b' },
      skewed as never,
    );

    const op = fixture.store
      .forDevice(fixture.deviceId)
      .map((row) => row.op)
      .filter((o) => o.type === 'notes.note_created')[0]!;
    expect(op.userId, 'the binding decides, not the public field').toBe(fixture.staffId);
    expect(fixture.evaluator.checks.at(-1)?.userId, 'and the check used the same identity').toBe(
      fixture.staffId,
    );
  });
});
