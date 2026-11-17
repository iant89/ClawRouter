import type { FieldIssue } from '@clawrouter/shared';

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'metadata.azure.com', '169.254.169.254', '[fd00:ec2::254]']);

/**
 * The host as the checks below see it: lower case, without a trailing dot, and an
 * IPv4-mapped IPv6 address (`[::ffff:a9fe:a9fe]`) as the IPv4 address it reaches.
 * Without this, `metadata.google.internal.` and `[::ffff:169.254.169.254]` slipped
 * past the metadata check (audit, 2026-11-17).
 */
function canonicalHost(hostname: string): string {
  const h = hostname.toLowerCase().replace(/\.+$/, '');
  const hex = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(h);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return /^\[::ffff:(\d{1,3}(?:\.\d{1,3}){3})\]$/.exec(h)?.[1] ?? h;
}

function isLoopbackOrPrivate(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 unique local
  // Single-label hosts (e.g. a Docker service name "ollama") are on the local network.
  return !h.includes('.') && !h.includes(':');
}

/**
 * Endpoint policy for provider base URLs:
 *   - http(s) only, no credentials or query/fragment in the URL;
 *   - plain http only for loopback / private / single-label hosts (local models);
 *   - cloud metadata addresses and link-local ranges are refused.
 * Admins choose endpoints, so private hosts stay allowed for local providers.
 */
export function checkEndpoint(raw: string, path = 'endpoint'): { url: string | null; issues: FieldIssue[] } {
  const issue = (message: string) => ({ url: null, issues: [{ path, message }] });
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return issue('must be a valid URL, e.g. https://api.example.com/v1');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return issue('must use http or https');
  if (url.username || url.password) return issue('must not contain credentials; set the API key separately');
  if (url.search || url.hash) return issue('must not contain a query string or fragment');
  const host = canonicalHost(url.hostname);
  if (METADATA_HOSTS.has(host) || /^169\.254\./.test(host) || /^\[?fe80:/i.test(host)) return issue('must not point at a cloud metadata or link-local address');
  if (url.protocol === 'http:' && !isLoopbackOrPrivate(host)) return issue('must use https for hosts outside the local network');
  return { url: url.toString().replace(/\/+$/, ''), issues: [] };
}
