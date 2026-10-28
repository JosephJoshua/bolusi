// The approvals port the screens use (04 §7): the module's commands and queries, run as the person
// signed in. A module whose records take requests (repair) carries it on its own runtime.
import type { ModulePort } from '@bolusi/core';

import type { ApprovalsModule } from './manifest.js';

export type ApprovalsPort = ModulePort<ApprovalsModule>;
