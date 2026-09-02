// The `VirtualDevice` body now lives in the platform-free shared rig (@bolusi/test-support/chaos,
// task 181), injected with `ConvergenceSeams`. This file is the NODE binding: it pre-binds the seam
// to `NODE_SEAMS` (better-sqlite3 DB + the real `@bolusi/modules` notes trio), so every existing
// harness scenario keeps calling `VirtualDevice.open(options)` with no seam argument.
//
// `VirtualDevice` is used as BOTH a type (`readonly devices: VirtualDevice[]`) and a value
// (`VirtualDevice.open(...)`) across the scenarios, so the shim merges a type alias with a value
// object whose `open` pre-binds the seam — a type and a value can share a name (separate namespaces).
import { VirtualDevice as SharedVirtualDevice } from '@bolusi/test-support/chaos';

import { NODE_SEAMS } from './seams-node.js';

export type { DeviceIdentity, ExtraModule } from '@bolusi/test-support/chaos';

/** The Node-bound VirtualDevice type — identical to the shared class instance. */
export type VirtualDevice = SharedVirtualDevice;

/** The Node-bound VirtualDevice value: `open` pre-binds `NODE_SEAMS` so scenarios call it seam-free. */
export const VirtualDevice = {
  open(options: Parameters<typeof SharedVirtualDevice.open>[0]): Promise<SharedVirtualDevice> {
    return SharedVirtualDevice.open(options, NODE_SEAMS);
  },
};
