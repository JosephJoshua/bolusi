// The stage chips' icons on the PC, by the shared names `STAGE_CHIP` gives them.
import { Ban, Check, Clock, Pencil, TriangleAlert, type LucideIcon } from 'lucide-react';

import type { STAGE_CHIP } from '../order-form.js';

type StageIcon = (typeof STAGE_CHIP)[keyof typeof STAGE_CHIP]['icon'];

export const STAGE_ICON: Readonly<Record<StageIcon, LucideIcon>> = {
  pending: Clock,
  check: Check,
  warning: TriangleAlert,
  remove: Ban,
  edit: Pencil,
};
