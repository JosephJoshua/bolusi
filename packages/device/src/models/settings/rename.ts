// Renaming this device from Settings: the same name bound the enrolment wizard checks, and what a
// refused rename says. Shared by the phone and the counter PC so both explain it the same way.
import type { StaffAdminFailure } from '@bolusi/core';

import { DEVICE_NAME_MAX } from '../enrollment/model.js';

export type DeviceNameProblem = 'nameMissing' | 'nameTooLong';

/** Why `name` cannot be saved as this device's name, or null when it can. */
export function deviceNameProblem(name: string): DeviceNameProblem | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'nameMissing';
  if (trimmed.length > DEVICE_NAME_MAX) return 'nameTooLong';
  return null;
}

export const RENAME_PROBLEM_KEY = {
  nameMissing: 'auth.rename.problem.nameMissing',
  nameTooLong: 'auth.rename.problem.nameTooLong',
} as const satisfies Record<DeviceNameProblem, string>;

export const RENAME_FAILURE_KEY = {
  offline: 'auth.rename.failure.offline',
  denied: 'auth.rename.failure.denied',
  // Not a rename outcome; read as any other refusal.
  lastOwner: 'auth.rename.failure.unexpected',
  rateLimited: 'auth.rename.failure.rateLimited',
  unexpected: 'auth.rename.failure.unexpected',
} as const satisfies Record<StaffAdminFailure, string>;
