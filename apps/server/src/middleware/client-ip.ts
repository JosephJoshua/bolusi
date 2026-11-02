// The client address the per-IP limits key by, behind a reverse proxy. The socket peer of a
// proxied request is the proxy, so every client would share one bucket. X-Forwarded-For names the
// client, but anyone can send it, so it is read only when the peer is a configured trusted proxy,
// and then from the right: each trusted hop appended what it saw, and the first address from the
// right that is not a trusted proxy is the client. Entries left of it are the client's own say.
import { BlockList, isIP } from 'node:net';

/** An IPv4-mapped IPv6 address (`::ffff:10.0.0.1`) as the IPv4 address it carries. */
function unmapped(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address;
}

function isTrusted(trusted: BlockList, address: string): boolean {
  const bare = unmapped(address);
  const family = isIP(bare);
  if (family === 0) return false;
  return trusted.check(bare, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Parses `TRUSTED_PROXY_CIDRS`: comma-separated addresses or CIDR ranges (`10.0.0.0/8`, `::1`).
 * Throws on an entry that is neither.
 */
export function parseTrustedProxies(spec: string): BlockList {
  const trusted = new BlockList();
  for (const entry of spec.split(',').map((part) => part.trim())) {
    if (entry === '') continue;
    const [address = '', bits] = entry.split('/');
    const family = isIP(address);
    const prefix = bits === undefined ? (family === 4 ? 32 : 128) : Number(bits);
    if (
      family === 0 ||
      bits === '' ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > (family === 4 ? 32 : 128)
    ) {
      throw new Error(`not an address or CIDR range: ${entry}`);
    }
    trusted.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return trusted;
}

/**
 * The client's address: the socket peer, unless the peer is a trusted proxy, in which case the
 * rightmost X-Forwarded-For address that is not a trusted proxy. With no trusted proxies
 * configured the header is never read.
 */
export function clientIpBehindProxies(
  peer: string,
  forwardedFor: string | undefined,
  trusted: BlockList | undefined,
): string {
  if (trusted === undefined || !isTrusted(trusted, peer) || forwardedFor === undefined) return peer;
  let client = peer;
  const hops = forwardedFor.split(',').map((hop) => hop.trim());
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i] ?? '';
    // A hop that is not an address was not written by a trusted proxy: stop at the last one that was.
    if (isIP(unmapped(hop)) === 0) return client;
    client = hop;
    if (!isTrusted(trusted, hop)) return client;
  }
  return client;
}
