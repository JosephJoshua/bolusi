/**
 * The server address this app syncs with, without a trailing slash, or '' for none. An installed app
 * only talks to the server over HTTPS, since PINs, sessions and money cross it; plain HTTP is for a
 * developer's local server.
 */
export function serverAddress(value: string, packaged: boolean): string {
  const address = value.trim().replace(/\/+$/, '');
  let protocol: string;
  try {
    protocol = new URL(address).protocol;
  } catch {
    return '';
  }
  return protocol === 'https:' || (!packaged && protocol === 'http:') ? address : '';
}
