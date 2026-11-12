/** "3d 4h", "2h 5m", "45s" */
export function formatUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function formatTime(iso: string, locale?: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const COMPONENT_LABELS: Record<string, string> = {
  platform: 'Platform',
  database: 'Database',
  gateway: 'Gateway',
  authentication: 'Authentication',
  'provider-engine': 'Provider engine',
  providers: 'Providers',
  websocket: 'WebSocket',
  api: 'API',
};

export function componentLabel(component: string): string {
  return COMPONENT_LABELS[component] ?? component;
}

/**
 * Short device description from a User-Agent string, e.g. "Chrome on macOS".
 * Display only: user agents are client-supplied and not trustworthy.
 */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /HeadlessChrome\//.test(ua) ? 'Headless Chrome'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
    : /^curl\//.test(ua) ? 'curl'
    : /^(Bun|node|undici)/i.test(ua) ? 'Script'
    : null;
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" */
export function formatRelative(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso));
  if (Number.isNaN(diff)) return '—';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/**
 * Token counts as model specs write them: the unit that gives an exact whole
 * number wins, decimal first (128000 -> "128K", 2000000 -> "2M"), then binary
 * (8192 -> "8K", 131072 -> "128K", 1048576 -> "1M"); otherwise decimal with
 * one decimal place (1500 -> "1.5K").
 */
export function formatTokens(n: number | null): string {
  if (n === null) return '—';
  const units: [string, number][] = [['M', 1_000_000], ['M', 1_048_576], ['K', 1_000], ['K', 1_024]];
  for (const [unit, size] of units) {
    if (n >= size && n % size === 0) return `${n / size}${unit}`;
  }
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 100) / 10}K`;
  return String(n);
}

/** USD per million tokens: at least two decimals, more only when needed ($0.60, $0.075, $15.00). */
export function formatPrice(n: number | null): string {
  if (n === null) return '—';
  const wholeCents = Math.round(n * 100) === n * 100;
  return `$${wholeCents ? n.toFixed(2) : String(Number(n.toFixed(4)))}`;
}
