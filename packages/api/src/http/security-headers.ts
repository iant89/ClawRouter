/**
 * Security headers (spec §37). One place for the API's and the console's, so
 * they cannot drift apart.
 */

export interface SecurityHeaderOptions {
  /** HTTPS deployment (secure cookies): adds Strict-Transport-Security. */
  https: boolean;
}

/**
 * The console's Content-Security-Policy. Scripts and connections only from this
 * origin (the live channel is same-origin WebSocket); no framing (clickjacking);
 * no plugins; no <base> tricks. Styles allow inline because the design system
 * sets layout through style attributes; scripts never do.
 */
export const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** JSON and streams never need to load anything. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

/** Sets the headers every response gets, without replacing ones a handler chose. */
export function applySecurityHeaders(headers: Headers, csp: string, options: SecurityHeaderOptions): void {
  const set = (name: string, value: string) => {
    if (!headers.has(name)) headers.set(name, value);
  };
  set('content-security-policy', csp);
  set('x-content-type-options', 'nosniff');
  set('x-frame-options', 'DENY');
  set('referrer-policy', 'no-referrer');
  set('cross-origin-opener-policy', 'same-origin');
  set('cross-origin-resource-policy', 'same-origin');
  set('permissions-policy', PERMISSIONS_POLICY);
  // Only over HTTPS: on plain HTTP it is ignored anyway, and on localhost it would be wrong.
  if (options.https) set('strict-transport-security', 'max-age=31536000; includeSubDomains');
}
