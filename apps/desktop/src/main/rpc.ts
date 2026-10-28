// One small request/response protocol over a MessagePort, used between the window and the offline
// core, and between the core and the main process. Both ends speak structured-clone values, so
// bytes and nested records cross as they are; errors cross as their fields (name, code, status…)
// and come back out as an `Error` with the same fields, so `DomainError` checks and the enrolment
// failure buckets work across the boundary as they do in one process.

/** The common surface of a DOM `MessagePort` and Electron's `MessagePortMain`, bound by the caller
 * (`mainPortChannel` here; the window binds its DOM port itself). */
export interface Channel {
  send(message: unknown): void;
  /** Starts delivery; returns the unsubscribe. */
  listen(onMessage: (message: unknown) => void): () => void;
}

export type Handlers = Readonly<Record<string, (...args: never[]) => unknown>>;

/** What a thrown value becomes on the wire: every own enumerable field plus name and message. */
export interface WireError {
  readonly name: string;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

interface Request {
  readonly kind: 'request';
  readonly id: number;
  readonly method: string;
  readonly args: readonly unknown[];
}

type Reply =
  | { readonly kind: 'reply'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly kind: 'reply'; readonly id: number; readonly ok: false; readonly error: WireError };

interface Event {
  readonly kind: 'event';
  readonly name: string;
  readonly payload: unknown;
}

export function toWireError(error: unknown): WireError {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: String(error), fields: {} };
  }
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    // Functions and the cause chain do not cross; everything a caller branches on is plain data.
    if (typeof value !== 'function' && key !== 'cause') fields[key] = value;
  }
  return { name: error.name, message: error.message, fields };
}

/** A rebuilt error: `instanceof Error`, same name, message and fields (code, status, details…). */
export class RemoteError extends Error {
  constructor(wire: WireError) {
    super(wire.message);
    Object.assign(this, wire.fields);
    this.name = wire.name;
  }
}

/** Answers requests from the other end with `handlers`; also lets this end push events. */
export function serve(
  channel: Channel,
  handlers: Handlers,
): { emit(name: string, payload: unknown): void; close(): void } {
  const stop = channel.listen((message) => {
    const request = message as Partial<Request> | null;
    if (request?.kind !== 'request' || typeof request.id !== 'number') return;
    const { id, method = '', args = [] } = request;
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    void (async () => {
      try {
        if (handler === undefined) throw new Error(`no such call: ${method}`);
        const value: unknown = await (handler as (...a: readonly unknown[]) => unknown)(...args);
        channel.send({ kind: 'reply', id, ok: true, value } satisfies Reply);
      } catch (error) {
        channel.send({ kind: 'reply', id, ok: false, error: toWireError(error) } satisfies Reply);
      }
    })();
  });
  return {
    emit: (name, payload) => channel.send({ kind: 'event', name, payload } satisfies Event),
    close: stop,
  };
}

export interface Client {
  call<T>(method: string, ...args: readonly unknown[]): Promise<T>;
  on(name: string, listener: (payload: unknown) => void): () => void;
  close(): void;
}

/**
 * Calls the other end's handlers and listens to its events. `revive` rebuilds a typed error class
 * (the window turns a `DomainError` back into one, so `instanceof` checks keep working).
 */
export function connect(
  channel: Channel,
  revive: (wire: WireError) => Error = (wire) => new RemoteError(wire),
): Client {
  let nextId = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const stop = channel.listen((message) => {
    const data = message as Partial<Reply | Event> | null;
    if (data?.kind === 'reply') {
      const reply = data as Reply;
      const waiter = pending.get(reply.id);
      if (waiter === undefined) return;
      pending.delete(reply.id);
      if (reply.ok) waiter.resolve(reply.value);
      else waiter.reject(revive(reply.error));
    } else if (data?.kind === 'event') {
      const event = data as Event;
      for (const listener of listeners.get(event.name) ?? []) listener(event.payload);
    }
  });
  return {
    call<T>(method: string, ...args: readonly unknown[]): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        channel.send({ kind: 'request', id, method, args } satisfies Request);
      });
    },
    on(name, listener) {
      let set = listeners.get(name);
      if (set === undefined) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    close() {
      stop();
      for (const waiter of pending.values()) waiter.reject(new Error('the connection closed'));
      pending.clear();
    },
  };
}
