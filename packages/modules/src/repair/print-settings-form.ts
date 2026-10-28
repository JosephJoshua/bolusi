// The owner's "Tampilan nota" form as pure state, shared by the phone and the counter PC screens:
// what the form holds for saved settings, whether it changed, and the command input it saves as.
import type { MediaRef, MediaRefMime } from '@bolusi/schemas';

import type { SetPrintSettingsInput } from './commands.js';
import { tn } from './i18n.js';
import type { PrintSettings } from './queries.js';

/** The logo as the form holds it: the signed ref, whether just picked or as saved. */
export type PrintSettingsLogo = Pick<MediaRef, 'mediaId' | 'sha256' | 'mime'>;

export interface PrintSettingsForm {
  readonly name: string;
  readonly address: string;
  readonly phone: string;
  readonly logo: PrintSettingsLogo | MediaRef | null;
  readonly logoOnDotMatrix: boolean;
  readonly intakeTerms: string;
  readonly handoverTerms: string;
}

/** The form for saved settings, with the app's terms filled in where the store has none. */
export function printSettingsForm(saved: PrintSettings): PrintSettingsForm {
  return {
    name: saved.name ?? '',
    address: saved.address,
    phone: saved.phone,
    logo: saved.logo === null ? null : { ...saved.logo, mime: saved.logo.mime as MediaRefMime },
    logoOnDotMatrix: saved.logoOnDotMatrix,
    intakeTerms: saved.intakeTerms ?? tn('repair.slip.terms.intake'),
    handoverTerms: saved.handoverTerms ?? tn('repair.slip.terms.handover'),
  };
}

/** Whether one field holds the same in two forms: text ignoring outer spaces, a logo by its media. */
export function samePrintSettingsField<K extends keyof PrintSettingsForm>(
  key: K,
  a: PrintSettingsForm[K],
  b: PrintSettingsForm[K],
): boolean {
  if (key === 'logo') {
    const [x, y] = [a as PrintSettingsForm['logo'], b as PrintSettingsForm['logo']];
    return (x?.mediaId ?? null) === (y?.mediaId ?? null);
  }
  return typeof a === 'string' && typeof b === 'string' ? a.trim() === b.trim() : a === b;
}

export function samePrintSettingsForm(a: PrintSettingsForm, b: PrintSettingsForm): boolean {
  return (Object.keys(a) as (keyof PrintSettingsForm)[]).every((key) =>
    samePrintSettingsField(key, a[key], b[key]),
  );
}

/** Terms left as the app's own are saved as none, so the store keeps getting the app's wording. */
function termsToSave(text: string, defaults: string): string | null {
  return text.trim() === defaults.trim() ? null : text;
}

/** The `setPrintSettings` input for a form. */
export function printSettingsInput(form: PrintSettingsForm): SetPrintSettingsInput {
  // A logo picked here carries its whole signed ref; one already saved is unchanged, so the
  // command keeps the stored one.
  const logo = form.logo === null ? null : 'type' in form.logo ? form.logo : undefined;
  return {
    name: form.name,
    address: form.address.trim(),
    phone: form.phone.trim(),
    ...(logo === undefined ? {} : { logo }),
    logoOnDotMatrix: form.logoOnDotMatrix,
    intakeTerms: termsToSave(form.intakeTerms, tn('repair.slip.terms.intake')),
    handoverTerms: termsToSave(form.handoverTerms, tn('repair.slip.terms.handover')),
  };
}
