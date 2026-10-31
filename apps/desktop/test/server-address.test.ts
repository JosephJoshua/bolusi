// @vitest-environment node
// Where the app syncs: an installed app refuses a plain-HTTP server, a developer's build may use one.
import { describe, expect, it } from 'vitest';

import { serverAddress } from '../src/main/server-address.js';

describe('the server address', () => {
  it('takes an https address in an installed app, without trailing slashes', () => {
    expect(serverAddress('https://api.bolusi.id/', true)).toBe('https://api.bolusi.id');
    expect(serverAddress(' https://api.bolusi.id/v1// ', true)).toBe('https://api.bolusi.id/v1');
  });

  it('refuses plain HTTP and other schemes in an installed app', () => {
    expect(serverAddress('http://api.bolusi.id', true)).toBe('');
    expect(serverAddress('HTTP://api.bolusi.id', true)).toBe('');
    expect(serverAddress('ftp://api.bolusi.id', true)).toBe('');
    expect(serverAddress('file:///C:/server', true)).toBe('');
  });

  it("allows plain HTTP for a developer's local server, but no other scheme", () => {
    expect(serverAddress('http://localhost:3000/', false)).toBe('http://localhost:3000');
    expect(serverAddress('https://api.bolusi.id', false)).toBe('https://api.bolusi.id');
    expect(serverAddress('ftp://localhost', false)).toBe('');
  });

  it('is empty when nothing or no URL is given', () => {
    expect(serverAddress('', true)).toBe('');
    expect(serverAddress('', false)).toBe('');
    expect(serverAddress('api.bolusi.id', true)).toBe('');
  });
});
