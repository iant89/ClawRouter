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
