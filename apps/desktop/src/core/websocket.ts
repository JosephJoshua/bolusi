// The live-updates socket on the PC. The shared realtime client opens it the React Native way,
// `new WebSocket(url, protocols, { headers })`, to send the device token on the upgrade. Node's
// WebSocket takes its headers in the second argument instead, so this adapts the one to the other.
import type { RealtimeSocketCtor } from '@bolusi/device/bootstrap/realtime-client';

class NodeRealtimeSocket extends WebSocket {
  constructor(
    url: string,
    protocols: string | string[] | null | undefined,
    options: { headers: Record<string, string> },
  ) {
    // Node's (undici's) init object; the DOM typing knows only the protocols form.
    super(url, { protocols: protocols ?? [], headers: options.headers } as unknown as string[]);
  }
}

// The DOM's handler types take an event the shared client never reads.
export const nodeRealtimeSocket = NodeRealtimeSocket as unknown as RealtimeSocketCtor;
