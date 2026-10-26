// What the repair screens show from a catalog model's spec sheet (PhoneSpecs, @bolusi/schemas),
// shaped for the person looking: the counter tells variants apart and fills the colour, the
// technician sees what to expect inside before opening the phone. Platform-free, so the desktop
// client reuses it.
import type { PhoneSpecs } from '@bolusi/schemas';

export type SpecFactKey =
  'memory' | 'screen' | 'chipset' | 'battery' | 'port' | 'sim' | 'cardSlot' | 'os';

export interface SpecFact {
  readonly key: SpecFactKey;
  readonly value: string;
}

const VARIANT = /(\d+)\s*(GB|TB|MB)\s+(\d+)\s*(GB|MB)\s+RAM/i;

/**
 * GSMArena's "128GB 8GB RAM, 256GB 8GB RAM" as Indonesian shops write it: "8/128GB", "8/256GB".
 * A variant in another shape is kept as written.
 */
export function memoryVariants(internalMemory: string | undefined): string[] {
  if (internalMemory === undefined) return [];
  const out: string[] = [];
  for (const part of internalMemory.split(',')) {
    const text = part.trim();
    if (text === '') continue;
    const match = VARIANT.exec(text);
    const variant =
      match === null
        ? text
        : `${match[3]}${match[4]!.toUpperCase() === 'GB' ? '' : match[4]!.toUpperCase()}/${match[1]}${match[2]!.toUpperCase()}`;
    if (!out.includes(variant)) out.push(variant);
  }
  return out;
}

/** The colours the model was sold in, for one-tap colour entry at intake. */
export function colourChoices(colors: string | undefined): string[] {
  if (colors === undefined) return [];
  const out: string[] = [];
  for (const part of colors.split(',')) {
    const colour = part.trim();
    if (colour !== '' && colour.length <= 40 && !out.includes(colour)) out.push(colour);
  }
  return out.slice(0, 8);
}

function joined(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined && part !== '');
  return present.length === 0 ? undefined : present.join(', ');
}

/**
 * The spec rows a person sees on a ticket. Everyone who reads tickets gets the memory variants
 * (the customer is asked which one); someone who repairs also gets screen, chipset, battery and
 * charging, port, SIM, card slot and system. Rows the catalog does not know are left out.
 */
export function specFacts(specs: PhoneSpecs, repairs: boolean): SpecFact[] {
  const memory = memoryVariants(specs.internalMemory).join(' · ');
  const rows: [SpecFactKey, string | undefined][] = [
    ['memory', memory === '' ? undefined : memory],
  ];
  if (repairs) {
    rows.push(
      ['screen', joined(specs.displaySize?.replace(/\binches\b/i, 'inci'), specs.displayType)],
      ['chipset', specs.chipset],
      ['battery', joined(specs.battery, specs.charging)],
      ['port', specs.usb],
      ['sim', specs.sim],
      ['cardSlot', specs.cardSlot],
      ['os', specs.os],
    );
  }
  return rows.flatMap(([key, value]) => (value === undefined ? [] : [{ key, value }]));
}
