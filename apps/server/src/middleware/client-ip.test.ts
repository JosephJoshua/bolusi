// Behind a proxy the socket peer is the proxy; X-Forwarded-For is believed only from a trusted one.
import { describe, expect, test } from 'vitest';

import { clientIpBehindProxies, parseTrustedProxies } from './client-ip.js';

const proxies = parseTrustedProxies('10.0.0.0/8, ::1');

describe('clientIpBehindProxies', () => {
  test('with no trusted proxies configured the header is never read', () => {
    expect(clientIpBehindProxies('10.0.0.2', '203.0.113.9', undefined)).toBe('10.0.0.2');
  });

  test('a peer that is not a trusted proxy is the client, whatever it forwards', () => {
    expect(clientIpBehindProxies('198.51.100.4', '203.0.113.9', proxies)).toBe('198.51.100.4');
  });

  test('from a trusted proxy, the rightmost forwarded address that is not one', () => {
    expect(clientIpBehindProxies('10.0.0.2', '203.0.113.9', proxies)).toBe('203.0.113.9');
    expect(clientIpBehindProxies('::ffff:10.0.0.2', '203.0.113.9', proxies)).toBe('203.0.113.9');
    expect(clientIpBehindProxies('::1', '203.0.113.9, 10.1.1.1', proxies)).toBe('203.0.113.9');
    // A client's own made-up entries sit left of the real one and are not believed.
    expect(clientIpBehindProxies('10.0.0.2', '1.2.3.4, 203.0.113.9', proxies)).toBe('203.0.113.9');
  });

  test('a trusted proxy without the header, or with junk in it, keys by the last trusted hop', () => {
    expect(clientIpBehindProxies('10.0.0.2', undefined, proxies)).toBe('10.0.0.2');
    expect(clientIpBehindProxies('10.0.0.2', 'junk', proxies)).toBe('10.0.0.2');
    expect(clientIpBehindProxies('10.0.0.2', 'junk, 10.0.0.3', proxies)).toBe('10.0.0.3');
  });
});

describe('parseTrustedProxies', () => {
  test('takes addresses and CIDR ranges, and refuses anything else', () => {
    const list = parseTrustedProxies('127.0.0.1,192.168.0.0/16,fd00::/8');
    expect(list.check('127.0.0.1', 'ipv4')).toBe(true);
    expect(list.check('127.0.0.2', 'ipv4')).toBe(false);
    expect(list.check('192.168.4.4', 'ipv4')).toBe(true);
    expect(list.check('fd12::1', 'ipv6')).toBe(true);
    expect(() => parseTrustedProxies('proxy.local')).toThrow(/proxy\.local/);
    expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow();
    expect(() => parseTrustedProxies('10.0.0.0/')).toThrow();
  });
});
