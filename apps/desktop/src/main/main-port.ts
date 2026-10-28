// The rpc `Channel` over Electron's `MessagePortMain`, the port type the main and utility processes
// hold (the window's end is a DOM `MessagePort`; see `domPortChannel`).
import type { MessagePortMain } from 'electron';

import type { Channel } from './rpc.js';

export function mainPortChannel(port: MessagePortMain): Channel {
  return {
    send: (message) => port.postMessage(message),
    listen(onMessage) {
      const handler = (event: { data: unknown }): void => onMessage(event.data);
      port.on('message', handler);
      port.start();
      return () => port.off('message', handler);
    },
  };
}
