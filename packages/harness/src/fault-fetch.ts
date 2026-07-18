// FaultFetch (testing-guide §3.5) — the fault-injecting `fetch` wrapper that is ALSO the only
// surface in the repo that sees every outbound request (SEC-DEV-05). It wraps the in-process
// server's `app.fetch` (no sockets, no ports): the client sync loop's transport calls THIS instead
// of the network, so the harness can (a) capture every request body + the server's log lines to
// prove no private-key material ever leaves the device, and (b) inject the §3.5 fault points at a
// scheduled request index.
//
// F1 (never reaches server) and F2 (server processes, response lost) live HERE, at the fetch
// boundary. F3/F4/F5 are client-CRASH semantics (in-memory-state discard, cursor-vs-apply timing,
// mid-transaction rollback) that the DEVICE models — a fetch wrapper cannot express them — so this
// file schedules them and exposes the trigger; the device consumes it.
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A §3.5 fault point. */
export type FaultPoint = 'F1' | 'F2' | 'F3' | 'F4' | 'F5';

/** A captured outbound request — the whole set is the SEC-DEV-05 assertion surface (T-14). */
export interface CapturedRequest {
  readonly index: number;
  readonly method: string;
  readonly url: string;
  readonly bodyText: string;
  readonly authorization: string | null;
}

export class NetworkDroppedError extends Error {
  constructor(readonly point: FaultPoint) {
    super(`FaultFetch injected ${point}`);
    this.name = 'NetworkDroppedError';
  }
}

/** A scheduled fault: fire `point` when the wrapper reaches request ordinal `atIndex`. */
export interface ScheduledFault {
  readonly atIndex: number;
  readonly point: FaultPoint;
}

/**
 * Wrap a `fetch`-like function with request capture and fault injection. `requests` accumulates
 * EVERY outbound request (body + Authorization), which is what SEC-DEV-05 asserts over. `logLines`
 * collects any strings the server (or the harness) routes here as "log output" for the same scan.
 */
export class FaultFetch {
  readonly requests: CapturedRequest[] = [];
  readonly logLines: string[] = [];
  /** F3/F4/F5 fired at the fetch boundary, for the device to observe and model the crash. */
  readonly firedClientCrashes: { index: number; point: FaultPoint }[] = [];
  #index = 0;

  constructor(
    private readonly inner: FetchLike,
    private readonly schedule: readonly ScheduledFault[] = [],
  ) {}

  /** The number of outbound requests seen so far — the batch-boundary counter (§3.5). */
  get requestCount(): number {
    return this.#index;
  }

  record(line: string): void {
    this.logLines.push(line);
  }

  readonly fetch: FetchLike = async (input, init) => {
    const index = this.#index;
    this.#index += 1;
    const bodyText = typeof init.body === 'string' ? init.body : '';
    const headers = new Headers(init.headers ?? {});
    this.requests.push({
      index,
      method: init.method ?? 'GET',
      url: input,
      bodyText,
      authorization: headers.get('Authorization'),
    });

    const fault = this.schedule.find((f) => f.atIndex === index);
    if (fault?.point === 'F1') {
      // Request never reaches the server.
      throw new NetworkDroppedError('F1');
    }
    if (fault?.point === 'F2') {
      // Server processes the request FULLY, then the response is lost in transit.
      await this.inner(input, init);
      throw new NetworkDroppedError('F2');
    }
    if (fault?.point === 'F3' || fault?.point === 'F4' || fault?.point === 'F5') {
      this.firedClientCrashes.push({ index, point: fault.point });
    }
    return this.inner(input, init);
  };
}
