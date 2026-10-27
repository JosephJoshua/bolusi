// The future-clock guard. Last-writer-wins orders ops by their device timestamp, so an op stamped
// in the future would beat every honest change made before that moment. The server refuses an op
// stamped more than CLOCK_AHEAD_MARGIN_MS past its own clock, and a device that has seen its clock
// run ahead by that much refuses to save work at all, so nobody records changes the server will
// throw away.
//
// The device learns its offset at each pull: `lastServerTimeReceivedAt` (device clock) minus
// `lastServerTime` (the server's clock in the same response). That reading describes the clock the
// device had then. If the clock was moved back since (`now < receivedAt`), the reading is stale and
// the guard stands aside until the next pull measures again; a clock moved forward after a pull is
// caught by the server instead, and the next pull blocks the device.
import { DomainError } from '../errors/domain-error.js';

/** How far ahead of the server a timestamp may be. Covers response latency and ordinary drift. */
export const CLOCK_AHEAD_MARGIN_MS = 10 * 60 * 1000;

/** True when an op stamped `timestamp` is too far ahead of the server's `receivedAt`. */
export function isAheadOfServer(timestamp: number, receivedAt: number): boolean {
  return timestamp - receivedAt > CLOCK_AHEAD_MARGIN_MS;
}

export interface ClockReading {
  readonly lastServerTime: number | null;
  readonly lastServerTimeReceivedAt: number | null;
}

/** True when the last pull found this device's clock too far ahead, and it is still that clock. */
export function isDeviceClockAhead(reading: ClockReading, now: number): boolean {
  const { lastServerTime, lastServerTimeReceivedAt: receivedAt } = reading;
  if (lastServerTime === null || receivedAt === null) return false;
  return now >= receivedAt && isAheadOfServer(receivedAt, lastServerTime);
}

/** Refuse a command on a device whose clock is known to run ahead (DomainError `CLOCK_AHEAD`). */
export function assertDeviceClockTrusted(reading: ClockReading, now: number): void {
  if (!isDeviceClockAhead(reading, now)) return;
  throw new DomainError(
    'CLOCK_AHEAD',
    { aheadMs: (reading.lastServerTimeReceivedAt ?? 0) - (reading.lastServerTime ?? 0) },
    'this device clock ran ahead of the server at the last sync',
  );
}
