// The `PushPort` seam (api/04-push §7). The FCM/Expo send is OUTWARD-FACING — every test runs
// against `FakePushPort`, never the real service (CLAUDE.md §6: no real send in a test). Production
// binds `ExpoPushSender` (expo-sender.ts) in `main.ts` via `pushPortFromConfig` (expo-transport.ts,
// keyed on `EXPO_ACCESS_TOKEN`); `resolveDeps`'s field default is `unconfiguredPushPort` (below),
// which THROWS on use rather than silently dropping — main.ts always overrides it, tests bind the
// fake, and the boot fails closed if the token is absent (task 134). A silent default no-op is the
// exact defect this task removed.
//
// A push is addressed to a device (api/04-push §2): we carry `deviceId` alongside the token on both
// the way out and back, so a `DeviceNotRegistered` ticket/receipt maps to the row to delete (§8)
// without trusting the token string to round-trip.
import type { OutgoingPush } from './payload.js';

/**
 * A send ticket (api/04-push §7; Expo's `push/send` `data[]`, one per message, in order). `ok`
 * carries a `receiptId` to poll later (§8; receipts.ts); `error` carries Expo's error code
 * (`DeviceNotRegistered`, `MessageTooBig`, `InvalidCredentials`, …). `deviceId`/`token` are OUR
 * correlation back to the sent message, not fields Expo echoes.
 */
export interface PushTicket {
  readonly deviceId: string;
  readonly token: string;
  readonly status: 'ok' | 'error';
  /** Present iff `status === 'ok'` — the Expo receipt id (§8). */
  readonly receiptId?: string;
  /** Present iff `status === 'error'` — Expo's `details.error` code. */
  readonly error?: string;
  readonly message?: string;
}

/** A delayed delivery receipt (api/04-push §8; Expo's `push/getReceipts` `data[receiptId]`). */
export interface PushReceipt {
  readonly status: 'ok' | 'error';
  /** Present iff `status === 'error'` — e.g. `DeviceNotRegistered`. */
  readonly error?: string;
  readonly message?: string;
}

/**
 * The push transport. `send` batches ≤ 100 messages/request internally (api/04-push §7) and returns
 * one ticket per message; `getReceipts` maps receipt ids to their delayed delivery status. Both are
 * best-effort (api/04-push §6) — a throw never reaches the request path (fanout dispatches
 * post-commit, fire-and-forget).
 */
export interface PushPort {
  send(messages: readonly OutgoingPush[]): Promise<readonly PushTicket[]>;
  getReceipts(receiptIds: readonly string[]): Promise<ReadonlyMap<string, PushReceipt>>;
}

/**
 * The `resolveDeps` field default (deps.ts). It exists so `createApp()` with no `pushPort` override
 * — the `AppType`-derivation instance and any partial-override test — CONSTRUCTS without reading
 * env, yet it can never become a silent no-op: both methods THROW. Production overrides it in
 * `main.ts` with the real `ExpoPushSender` (`pushPortFromConfig`); tests bind `FakePushPort`. If it
 * were ever reached at runtime the throw is caught by the fanout's fire-and-forget dispatch and
 * LOGGED (`dispatch_failed`) — loud, never a dead letter — but boot has already failed closed if
 * `EXPO_ACCESS_TOKEN` was absent, so a correctly-wired server never reaches it (task 134).
 */
export const unconfiguredPushPort: PushPort = {
  send() {
    return Promise.reject(
      new Error(
        'push port not configured: main.ts must inject the production ExpoPushSender ' +
          '(pushPortFromConfig / EXPO_ACCESS_TOKEN, api/04-push §7). A default no-op would make ' +
          'push a silent dead letter (task 134).',
      ),
    );
  },
  getReceipts() {
    return Promise.reject(new Error('push port not configured (task 134)'));
  },
};

/** A recorded `send` call — the WHOLE captured set (T-14: assertions read `sent`, not a sample). */
export interface RecordedSend {
  readonly messages: readonly OutgoingPush[];
}

/**
 * In-memory `PushPort` for tests. Records every sent message set and every getReceipts call, and
 * lets a test script ticket/receipt outcomes by token. Defaults: every send is `ok` with a
 * deterministic receipt id; every receipt is `ok`.
 */
export class FakePushPort implements PushPort {
  /** Every `send` batch, in call order — the full set the SEC/fanout tests assert over. */
  readonly sends: RecordedSend[] = [];
  /** Every receipt-id list passed to `getReceipts`, in call order. */
  readonly receiptQueries: string[][] = [];
  /** Scripted ticket errors by token (token → Expo error code). Absent ⇒ `ok`. */
  readonly ticketErrors = new Map<string, string>();
  /** Scripted receipt outcomes by receipt id (id → error code). Absent ⇒ `ok`. */
  readonly receiptErrors = new Map<string, string>();
  /** Make `send` throw once (network death) — proves the fire-and-forget isolation. */
  throwOnNextSend = false;

  #seq = 0;

  /** Every message ever sent, flattened across batches — convenience for whole-set assertions. */
  get allSent(): readonly OutgoingPush[] {
    return this.sends.flatMap((s) => s.messages);
  }

  /** Deterministic receipt id for a device's ok ticket (unique per send, no RNG — T-6). */
  #receiptId(deviceId: string): string {
    this.#seq += 1;
    return `receipt-${deviceId}-${this.#seq}`;
  }

  send(messages: readonly OutgoingPush[]): Promise<readonly PushTicket[]> {
    if (this.throwOnNextSend) {
      this.throwOnNextSend = false;
      return Promise.reject(new Error('fake push transport down'));
    }
    this.sends.push({ messages });
    const tickets: PushTicket[] = messages.map((m) => {
      const err = this.ticketErrors.get(m.to);
      if (err !== undefined) {
        return { deviceId: m.deviceId, token: m.to, status: 'error', error: err };
      }
      const receiptId = this.#receiptId(m.deviceId);
      // Record the receipt outcome under its own id if one was scripted for the device's token via
      // `scriptReceiptForToken` (below).
      const scripted = this.#pendingReceiptForToken.get(m.to);
      if (scripted !== undefined) this.receiptErrors.set(receiptId, scripted);
      return { deviceId: m.deviceId, token: m.to, status: 'ok', receiptId };
    });
    return Promise.resolve(tickets);
  }

  getReceipts(receiptIds: readonly string[]): Promise<ReadonlyMap<string, PushReceipt>> {
    this.receiptQueries.push([...receiptIds]);
    const out = new Map<string, PushReceipt>();
    for (const id of receiptIds) {
      const err = this.receiptErrors.get(id);
      out.set(id, err === undefined ? { status: 'ok' } : { status: 'error', error: err });
    }
    return Promise.resolve(out);
  }

  // A token whose eventual RECEIPT (not ticket) should carry an error — the receipt id is only known
  // after send, so we stash the intent by token and bind it to the minted id inside `send`.
  readonly #pendingReceiptForToken = new Map<string, string>();
  scriptReceiptError(token: string, error: string): void {
    this.#pendingReceiptForToken.set(token, error);
  }
}
