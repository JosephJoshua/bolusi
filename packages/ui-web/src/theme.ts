// The desktop/web theme: the phone's colour and spacing tokens (`@bolusi/ui/tokens`, the one source)
// published as CSS variables that `theme.css` maps into Tailwind, plus the desktop type ladder.
// A desktop is read closer and denser than a phone, so text is a step smaller; the floor stays 14.
import { color, identityPalette, radius } from '@bolusi/ui/tokens';

/** Desktop type ladder: display, title, heading, body and small, nothing in between. */
export const desktopType = Object.freeze({
  display: { size: 28, line: 36 },
  title: { size: 22, line: 30 },
  heading: { size: 17, line: 24 },
  body: { size: 15, line: 22 },
  small: { size: 14, line: 20 },
} as const);

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Every theme variable, as `--b-…` custom properties. */
export function themeVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(color)) vars[`--b-${kebab(name)}`] = value;
  identityPalette.forEach((value, index) => {
    vars[`--b-identity-${String(index)}`] = value;
  });
  for (const [name, value] of Object.entries(radius))
    vars[`--b-radius-${name}`] = `${String(value)}px`;
  for (const [name, { size, line }] of Object.entries(desktopType)) {
    vars[`--b-text-${name}`] = `${String(size)}px`;
    vars[`--b-text-${name}-line`] = `${String(line)}px`;
  }
  return vars;
}

/** Install the theme on the document root once, before the first render. */
export function applyTheme(root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(themeVariables())) root.style.setProperty(name, value);
}
