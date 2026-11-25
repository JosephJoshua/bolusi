// The transfer stage chips' icons on the PC, by the shared names `TRANSFER_STAGE_CHIP` gives them.
import { Ban, Check, Clock, TriangleAlert, type LucideIcon } from 'lucide-react';

import type { TRANSFER_STAGE_CHIP } from '../transfers/form.js';

type StageIcon = (typeof TRANSFER_STAGE_CHIP)[keyof typeof TRANSFER_STAGE_CHIP]['icon'];

export const STAGE_ICON: Readonly<Record<StageIcon, LucideIcon>> = {
  pending: Clock,
  check: Check,
  warning: TriangleAlert,
  remove: Ban,
};
