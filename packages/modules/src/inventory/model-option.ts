// The phone model an item can fit. Platform-free, so repair's catalog search (which the server
// reaches through the repair entry) can name it without pulling in the screens' React runtime.

/** A phone model from the phone catalog, offered when choosing what a part fits. */
export interface PhoneModelOption {
  readonly key: string;
  readonly brand: string;
  readonly model: string;
  /** Already-localized: "Samsung · 2024". */
  readonly caption: string;
}
