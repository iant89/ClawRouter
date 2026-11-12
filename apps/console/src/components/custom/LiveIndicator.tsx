import { StatusIndicator } from '@enterprise-ui/react';
import { useRealtimeState } from '../../features/realtime/RealtimeContext.tsx';
import type { RealtimeState } from '../../services/realtime.ts';

const STATE: Record<RealtimeState, { tone: 'success' | 'warning' | 'information' | 'neutral'; label: string; title: string }> = {
  live: { tone: 'success', label: 'Live', title: 'Pages update as things change.' },
  connecting: { tone: 'information', label: 'Connecting', title: 'Opening the live connection.' },
  reconnecting: { tone: 'warning', label: 'Reconnecting', title: 'The live connection was lost. Pages refresh periodically until it is back.' },
  offline: { tone: 'neutral', label: 'Offline', title: 'No live connection. Pages refresh periodically.' },
};

/** Header indicator for the console's live connection (text and icon, never color alone). */
export function LiveIndicator() {
  const s = STATE[useRealtimeState()];
  return <span title={s.title}><StatusIndicator tone={s.tone} size="sm">{s.label}</StatusIndicator></span>;
}
