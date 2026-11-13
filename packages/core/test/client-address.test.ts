import { describe, expect, test } from 'bun:test';
import { clientAddress, loadConfig, parseTrustedProxies } from '../src/index.ts';

const none = parseTrustedProxies('').proxies;
const lb = parseTrustedProxies('10.0.0.0/8, 192.0.2.10, fd00::/8').proxies;

describe('client address behind proxies', () => {
  test('without trusted proxies, X-Forwarded-For is ignored (a client cannot choose its address)', () => {
    expect(clientAddress('203.0.113.9', '1.2.3.4', none)).toBe('203.0.113.9');
  });

  test('a request not from a trusted proxy keeps its socket address', () => {
    expect(clientAddress('203.0.113.9', '1.2.3.4', lb)).toBe('203.0.113.9');
  });

  test('from a trusted proxy, the right-most untrusted hop is the client', () => {
    expect(clientAddress('10.1.1.1', '198.51.100.4', lb)).toBe('198.51.100.4');
    // A client-supplied first entry cannot win: the proxy appended the real one.
    expect(clientAddress('10.1.1.1', '1.2.3.4, 198.51.100.4', lb)).toBe('198.51.100.4');
    // Several trusted hops are skipped.
    expect(clientAddress('10.1.1.1', '198.51.100.4, 192.0.2.10, 10.9.9.9', lb)).toBe('198.51.100.4');
  });

  test('IPv4-mapped IPv6 and IPv6 ranges', () => {
    expect(clientAddress('::ffff:10.1.1.1', '198.51.100.4', lb)).toBe('198.51.100.4');
    expect(clientAddress('::ffff:203.0.113.9', null, none)).toBe('203.0.113.9');
    expect(clientAddress('fd12::1', '2001:db8::7', lb)).toBe('2001:db8::7');
  });

  test('garbage in the header never becomes the client address', () => {
    expect(clientAddress('10.1.1.1', 'not-an-ip', lb)).toBe('10.1.1.1');
    expect(clientAddress('10.1.1.1', 'evil, 198.51.100.4', lb)).toBe('198.51.100.4');
    expect(clientAddress('10.1.1.1', '198.51.100.4, <script>', lb)).toBe('10.1.1.1');
  });

  test('configuration is validated', () => {
    expect(loadConfig({ CLAWROUTER_TRUSTED_PROXIES: '127.0.0.1, 10.0.0.0/8' }).server.trustedProxies).toEqual(['127.0.0.1', '10.0.0.0/8']);
    expect(() => loadConfig({ CLAWROUTER_TRUSTED_PROXIES: '10.0.0.0/33, proxy.local' })).toThrow('CLAWROUTER_TRUSTED_PROXIES');
    expect(loadConfig({}).server.trustedProxies).toEqual([]);
  });
});
