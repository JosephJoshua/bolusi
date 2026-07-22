// The delivery-dispatch seam (api/04-push §1, §6; task 134 rework). Push is BEST-EFFORT and NEVER
// load-bearing — not on the correctness axis and not on the latency/availability axis. Delivery is
// network I/O to Expo/FCM whose failure modes (429, 5xx, a stalled socket) are IN-CONTRACT (§6),
// and `ExpoPushSender` retries them with real backoff sleeps up to minutes. So a delivery MUST NOT
// be awaited on the request path: if it were, an in-contract Expo outage would block the common
// sync-push write path for minutes and pile up workers — a self-inflicted outage of the core
// endpoint triggered by a third party. That is the exact "never load-bearing" the spec forbids.
//
// This seam is the fire-and-forget boundary. Every delivery is handed to `dispatch(task)` — the
// request path returns IMMEDIATELY; `task` runs to completion off the request path, its rejection
// swallowed (a dead push is logged, never surfaced as a sync error, §6). `flush()` exists ONLY for
// tests: it drains the in-flight tasks so a composed test can assert the fake sender received the
// message deterministically, without the fire-and-forget racing the assertion.

/**
 * Runs a delivery off the request path. Production installs `ImmediateDeliveryDispatcher`; tests
 * install the same class and call `flush()` to drain before asserting.
 */
export interface DeliveryDispatcher {
  /** Fire-and-forget `task`: START it, do NOT await it. A throw/hang inside `task` never reaches
   *  the caller — the request has already returned. */
  dispatch(task: () => Promise<void>): void;
  /** TEST-ONLY: resolve once every task dispatched so far has settled. Never called in production
   *  (a request must not wait on delivery); a production caller that awaited this would re-introduce
   *  the very coupling this seam removes. */
  flush(): Promise<void>;
}

/**
 * The production dispatcher. `dispatch` starts the task and tracks its promise so `flush` can await
 * it; the task's own rejection is swallowed here (best-effort, §6) so nothing escapes to the request
 * path and no unhandled rejection is raised. Starting the task synchronously touches only its cheap
 * prefix (the fanout awaits its first DB call immediately), so the request path is never blocked by
 * the network round-trip that follows the first `await`.
 */
export class ImmediateDeliveryDispatcher implements DeliveryDispatcher {
  readonly #pending = new Set<Promise<void>>();
  readonly #onError: (err: unknown) => void;

  constructor(
    onError: (err: unknown) => void = (err) => console.warn('[push] delivery failed', err),
  ) {
    this.#onError = onError;
  }

  dispatch(task: () => Promise<void>): void {
    let started: Promise<void>;
    try {
      started = task();
    } catch (err) {
      // A synchronous throw before the first await (the fanout functions never do this — they are
      // async and catch internally — but the seam must not leak it either way).
      this.#onError(err);
      return;
    }
    const tracked = started.catch((err) => {
      this.#onError(err);
    });
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  async flush(): Promise<void> {
    // A drained task could (in principle) have dispatched another; loop until the set is empty.
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
  }
}
