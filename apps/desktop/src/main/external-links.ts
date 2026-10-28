// Links the counter app may open outside itself. Kept apart from main.ts so it is tested without Electron.

/** The only pages a link may open, in the PC's own browser or app: WhatsApp, to message a customer. */
const EXTERNAL_HOSTS: ReadonlySet<string> = new Set(['wa.me']);

/** Whether a link may leave the app: https, to a listed host, with no login part. */
export function opensExternally(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === '' &&
      EXTERNAL_HOSTS.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}
