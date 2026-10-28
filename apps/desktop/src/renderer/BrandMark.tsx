// Bolusi's mark in the title bar. A stand-in until the real logo lands: the logo's own file replaces
// this drawing, at the same size and place.
export function BrandMark({ size = 20 }: { readonly size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden
      className="shrink-0"
      data-testid="desktop.brand"
    >
      <rect width="20" height="20" rx="5" fill="var(--b-primary)" />
      <path
        d="M6.5 4.75h4.1c2 0 3.15 1 3.15 2.6 0 1.05-.55 1.8-1.45 2.15 1.15.3 1.9 1.15 1.9 2.4 0 1.85-1.35 3.35-3.6 3.35H6.5Z"
        fill="#fff"
      />
      <circle cx="10.25" cy="12" r="1.35" fill="var(--b-primary)" />
    </svg>
  );
}
