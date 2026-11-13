import { BlockList, isIP } from 'node:net';

/**
 * The real client address behind trusted reverse proxies.
 *
 * Without configuration the socket address is used and `X-Forwarded-For` is
 * ignored: anyone can send that header, so trusting it blindly would let a
 * client pick its own address (and dodge per-address limits or forge audit
 * records). With `CLAWROUTER_TRUSTED_PROXIES`, the header is read only when the
 * connection comes from one of those proxies, from right to left, skipping
 * further trusted hops; the first address that is not a trusted proxy is the client.
 */
export interface TrustedProxies {
  /** Entries as configured (for logs and docs). */
  readonly entries: readonly string[];
  isTrusted(address: string): boolean;
}

const family = (address: string) => (isIP(address) === 6 ? 'ipv6' : 'ipv4');

/** Parses a comma-separated list of addresses and CIDR ranges. Returns the invalid entries too. */
export function parseTrustedProxies(raw: string | undefined): { proxies: TrustedProxies; invalid: string[] } {
  const list = new BlockList();
  const entries: string[] = [];
  const invalid: string[] = [];
  for (const entry of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [address = '', bits] = entry.split('/');
    const version = isIP(address);
    const prefix = bits === undefined ? undefined : Number(bits);
    if (!version || (prefix !== undefined && (!Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)))) {
      invalid.push(entry);
      continue;
    }
    if (prefix === undefined) list.addAddress(address, family(address));
    else list.addSubnet(address, prefix, family(address));
    entries.push(entry);
  }
  return {
    invalid,
    proxies: {
      entries,
      isTrusted: (address) => entries.length > 0 && isIP(address) !== 0 && list.check(address, family(address)),
    },
  };
}

/** Strips IPv4-mapped IPv6 ("::ffff:10.0.0.1" -> "10.0.0.1") so one client has one address. */
export function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped ? mapped[1]! : address;
}

/** Resolves the client address for a request that arrived on `socketAddress`. */
export function clientAddress(socketAddress: string | null, forwardedFor: string | null, proxies: TrustedProxies): string | null {
  if (socketAddress === null) return null;
  const socket = normalizeAddress(socketAddress);
  if (!forwardedFor || !proxies.isTrusted(socket)) return socket;
  const hops = forwardedFor.split(',').map((h) => normalizeAddress(h.trim()));
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    // A malformed entry ends the trusted chain: use the last address we could verify.
    if (!isIP(hop)) return i === hops.length - 1 ? socket : hops[i + 1]!;
    if (!proxies.isTrusted(hop)) return hop;
  }
  // Every hop is a trusted proxy: the left-most is the closest thing to a client.
  return hops[0] ?? socket;
}
