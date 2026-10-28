// What the main process and the core process say to each other.

/** The first message main sends the core, with its port to main. */
export interface CoreInit {
  readonly kind: 'init';
  readonly dataDir: string;
  readonly apiBaseUrl: string;
  readonly appVersion: string;
  readonly online: boolean;
}

/** Calls the core makes on main: the sealed secret store, which only main can reach. */
export const MAIN_CALLS = {
  secretGet: 'secrets.get',
  secretSet: 'secrets.set',
  secretDelete: 'secrets.delete',
} as const;

/** Events main pushes to the core. */
export const MAIN_EVENTS = {
  online: 'online',
  /** The PC woke from sleep: sync now rather than at the next timer. */
  resumed: 'resumed',
  /** The app is quitting: close the database and exit. */
  shutdown: 'shutdown',
} as const;
