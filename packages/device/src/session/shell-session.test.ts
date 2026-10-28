// SEC-AUTH-08 — the UI half (api/02-auth §6.4; this task's brief: "owed by THIS task ... before
// review"). Task 14's session.test.ts already drives the REAL SessionManager against the real
// command runtime and op log for the SessionManager half; per this task's brief the shell RENDERS
// 14's states and never duplicates its tests. What is proven HERE is the shell's own wiring:
//   - the tick delegates the lock DECISION to 14's checkIdle() and never re-derives the deadline;
//   - user A's workspace survives a lock and is restored EXACTLY on A's unlock;
//   - user B unlocking sees B's / empty — never A's;
//   - manual lock behaves identically, with `manual_lock`.
//
// Determinism (T-6): a FakeClock and a hand-driven tick. No real timers, no sleeps — the idle
// transition is a function call, which is exactly why 14 kept the timer out of SessionManager.
import type { ClockPort } from '@bolusi/core';
import { beforeEach, describe, expect, test } from 'vitest';

import { emptyWorkspace, withDraft, type UserWorkspace } from '../state/user-workspaces.js';

import type { ActiveSession, SessionPort } from './port.js';
import { ShellSession } from './shell-session.js';

/** A FakeClock (testing-guide §3.3): time only moves when a test moves it. */
function fakeClock(start = 1_000_000): ClockPort & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

const IDLE_SECONDS = 300;

/**
 * A fake `SessionPort` that mirrors 14's OBSERVABLE contract: a deadline `checkIdle()` compares
 * against the clock, and a per-user work map keyed by userId. `assertSessionManagerSatisfiesPort`
 * (port.ts) is what keeps this shape honest against the real class at compile time.
 */
class FakeSession implements SessionPort<UserWorkspace> {
  current: ActiveSession | null = null;
  readonly idleLockSeconds = IDLE_SECONDS;
  readonly emitted: string[] = [];
  readonly #work = new Map<string, UserWorkspace>();
  #deadline = Number.POSITIVE_INFINITY;
  #seq = 0;

  constructor(private readonly clock: ClockPort) {}

  async switchTo(userId: string) {
    if (this.current !== null) this.emitted.push('session_ended(switch)');
    this.emitted.push('user_switched');
    this.#seq += 1;
    this.current = { sessionId: `session-${this.#seq}`, userId };
    this.recordActivity();
    return { session: this.current, work: this.#work.get(userId), ops: [{}] };
  }

  async manualLock() {
    if (this.current === null) return [];
    this.emitted.push('session_ended(manual_lock)');
    this.current = null;
    return [{}];
  }

  async checkIdle() {
    if (this.current === null || this.clock.now() < this.#deadline) return [];
    this.emitted.push('session_ended(idle_lock)');
    this.current = null;
    return [{}];
  }

  recordActivity() {
    this.#deadline = this.clock.now() + this.idleLockSeconds * 1000;
  }

  saveWork(userId: string, work: UserWorkspace) {
    this.#work.set(userId, work);
  }

  work(userId: string) {
    return this.#work.get(userId);
  }
}

let clock: ReturnType<typeof fakeClock>;
let session: FakeSession;
let shell: ShellSession;

beforeEach(() => {
  clock = fakeClock();
  session = new FakeSession(clock);
  shell = new ShellSession({ session, clock });
});

/** Sign `userId` in and leave a distinctive draft on screen. */
async function signInWithDraft(userId: string, draft: string): Promise<UserWorkspace> {
  await shell.unlock(userId);
  const workspace = withDraft(emptyWorkspace(userId), 'notes', { body: draft });
  shell.updateWorkspace(workspace);
  return workspace;
}

describe('the idle tick delegates the decision to 14`s checkIdle (api/02-auth §6.4)', () => {
  test('no lock before the deadline; the session stays open', async () => {
    await shell.unlock('user-a');
    clock.advance(IDLE_SECONDS * 1000 - 1);
    expect(await shell.tick()).toBe(false);
    expect(shell.snapshot().locked).toBe(false);
    expect(session.emitted).not.toContain('session_ended(idle_lock)');
  });

  test('the timer firing locks the shell and requests 14`s session_ended(idle_lock)', async () => {
    await shell.unlock('user-a');
    clock.advance(IDLE_SECONDS * 1000);

    expect(await shell.tick()).toBe(true);
    const snapshot = shell.snapshot();
    expect(snapshot.locked).toBe(true);
    expect(snapshot.lockReason).toBe('idle_lock');
    expect(snapshot.userId).toBeNull();
    expect(session.emitted).toContain('session_ended(idle_lock)');
  });

  test('activity resets the deadline — the shell does not lock a user who is working', async () => {
    await shell.unlock('user-a');
    clock.advance(IDLE_SECONDS * 1000 - 1);
    shell.recordActivity();
    clock.advance(IDLE_SECONDS * 1000 - 1);
    expect(await shell.tick()).toBe(false);
    expect(shell.snapshot().locked).toBe(false);
  });

  test('the tick emits session_ended EXACTLY once, however many times it fires', async () => {
    // The tick runs on an interval; a lock that emitted per tick would spray duplicate ops into an
    // immutable, forever-replicated log for as long as the device sat at the lock screen.
    await shell.unlock('user-a');
    clock.advance(IDLE_SECONDS * 1000);
    for (let i = 0; i < 5; i += 1) await shell.tick();
    expect(session.emitted.filter((op) => op === 'session_ended(idle_lock)')).toHaveLength(1);
  });

  test('ticking with nobody signed in is a no-op — no op is emitted at the switcher', async () => {
    clock.advance(IDLE_SECONDS * 1000 * 10);
    expect(await shell.tick()).toBe(false);
    expect(session.emitted).toHaveLength(0);
  });
});

describe('SEC-AUTH-08 — a lock preserves work; an unlock restores exactly the owner`s', () => {
  test('A`s draft survives the idle lock and is restored EXACTLY on A`s unlock', async () => {
    const saved = await signInWithDraft('user-a', 'ganti LCD iPhone 11');
    clock.advance(IDLE_SECONDS * 1000);
    await shell.tick();

    // Locked: the shell holds no workspace at all — nothing to leak behind the lock screen.
    expect(shell.snapshot().workspace).toBeNull();

    const restored = await shell.unlock('user-a');
    expect(restored).toEqual(saved);
    expect(shell.snapshot().workspace).toEqual(saved);
  });

  test('B unlocking after A`s lock sees B`s OWN empty workspace, never A`s', async () => {
    // The core of SEC-AUTH-08: a shared terminal must not hand B the note A was typing.
    const aWork = await signInWithDraft('user-a', 'ganti baterai Samsung A12');
    clock.advance(IDLE_SECONDS * 1000);
    await shell.tick();

    const bWorkspace = await shell.unlock('user-b');
    expect(bWorkspace).toEqual(emptyWorkspace('user-b'));
    expect(bWorkspace.ownerUserId).toBe('user-b');
    expect(bWorkspace.drafts).toEqual({});
    // A's work is not merely hidden from B — it is still A's, intact, for A's next unlock.
    expect(JSON.stringify(bWorkspace)).not.toContain('Samsung A12');
    expect(session.work('user-a')).toEqual(aWork);
  });

  test('A`s work survives B using the terminal in between — the map is keyed by user', async () => {
    const aWork = await signInWithDraft('user-a', 'servis mesin cuci');
    clock.advance(IDLE_SECONDS * 1000);
    await shell.tick();

    await signInWithDraft('user-b', 'jual charger');
    clock.advance(IDLE_SECONDS * 1000);
    await shell.tick();

    expect(await shell.unlock('user-a')).toEqual(aWork);
  });

  test('a workspace claiming another owner is refused — the restore is checked, not trusted', async () => {
    // Adversarial: force a mislabelled workspace into retention and prove the owner check catches
    // it. In correct code this cannot happen (the key IS the userId), which is exactly why the
    // check is asserted rather than assumed — a control nobody can witness is not a control.
    session.saveWork('user-b', withDraft(emptyWorkspace('user-a'), 'notes', { body: 'A only' }));

    const restored = await shell.unlock('user-b');
    expect(restored).toEqual(emptyWorkspace('user-b'));
    expect(JSON.stringify(restored)).not.toContain('A only');
  });

  test('a stale screen cannot write into the signed-in user`s workspace', async () => {
    await shell.unlock('user-b');
    // A closure captured while A was signed in tries to write after B took over.
    shell.updateWorkspace(withDraft(emptyWorkspace('user-a'), 'notes', { body: 'A stale' }));

    expect(shell.snapshot().workspace?.ownerUserId ?? 'user-b').toBe('user-b');
    expect(JSON.stringify(shell.snapshot())).not.toContain('A stale');
    expect(session.work('user-b')).toBeUndefined();
  });
});

describe('manual lock behaves identically, with `manual_lock` (api/02-auth §6.4)', () => {
  test('manual lock ends the session, preserves work, and reports the right reason', async () => {
    const saved = await signInWithDraft('user-a', 'tukar layar Oppo');
    await shell.lockNow();

    const snapshot = shell.snapshot();
    expect(snapshot.locked).toBe(true);
    expect(snapshot.lockReason).toBe('manual_lock');
    expect(snapshot.userId).toBeNull();
    expect(snapshot.workspace).toBeNull();
    expect(session.emitted).toContain('session_ended(manual_lock)');
    expect(session.emitted).not.toContain('session_ended(idle_lock)');

    expect(await shell.unlock('user-a')).toEqual(saved);
  });

  test('manual lock at the switcher is a no-op — there is no session to end', async () => {
    await shell.lockNow();
    expect(session.emitted).toHaveLength(0);
  });
});
