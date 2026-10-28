// What the PC's Settings may do for the person signed in, built from the core's state: their own
// PIN, colleagues' PINs and "Karyawan". Each part is present only for someone allowed it, so a page
// they may not use is absent rather than shown and refused; the core and the server still decide.
import type { StaffControls } from '@bolusi/device/bootstrap/staff';
import type { PinTargetUser } from '@bolusi/device/models/pin/pin-target';
import type { DeviceInfo } from '@bolusi/device/models/settings/model';

export interface StaffPinAccess {
  readonly canUnlock: boolean;
  readonly canReset: boolean;
  /** Colleagues whose PIN is locked on this PC now, for the count beside "PIN karyawan". */
  readonly lockedCount: number;
  readonly list: () => Promise<readonly PinTargetUser[]>;
  /** Each REJECTS with the core flow's DomainError. */
  readonly clearLockout: (targetUserId: string) => Promise<void>;
  readonly resetPin: (targetUserId: string, newPin: string) => Promise<void>;
}

export interface SettingsAccess {
  /** Change the signed-in person's own PIN; REJECTS with the flow's DomainError. */
  readonly changePin?: ((currentPin: string, newPin: string) => Promise<void>) | undefined;
  readonly staffPins?: StaffPinAccess | undefined;
  readonly staff?: StaffControls | undefined;
  /** This PC as registered; null before the core read it. */
  readonly device?: DeviceInfo | null | undefined;
}
