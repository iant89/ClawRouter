import type { ComponentHistory, HealthState } from '@clawrouter/shared';
import { HEALTH_LABEL } from './HealthStateIndicator.tsx';

const COLOR: Record<HealthState, string> = {
  HEALTHY: 'var(--eui-color-success)',
  DEGRADED: 'var(--eui-color-warning)',
  OFFLINE: 'var(--eui-color-error)',
  UNKNOWN: 'var(--eui-color-neutral)',
  DISABLED: 'var(--eui-color-border-strong)',
};

/**
 * A strip of time buckets coloured by the worst status in each. Color is never
 * the only signal: every bucket has a text label (title and accessible name),
 * and the component's availability and changes are written next to it.
 */
export function HealthTimeline({ history, bucketMinutes }: { history: ComponentHistory; bucketMinutes: number }) {
  const span = (start: string) => {
    const from = new Date(start);
    const to = new Date(from.getTime() + bucketMinutes * 60_000);
    const time = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${from.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time(from)}–${time(to)}`;
  };
  return (
    <div role="list" aria-label="Status over time, oldest first" className="claw-timeline">
      {history.buckets.map((b) => {
        const label = `${span(b.start)}: ${b.status ? `${HEALTH_LABEL[b.status]} (worst of ${b.checks} check${b.checks === 1 ? '' : 's'})` : 'no checks'}`;
        return (
          <span
            key={b.start}
            role="listitem"
            aria-label={label}
            title={label}
            className="claw-timeline-bucket"
            style={{ background: b.status ? COLOR[b.status] : 'transparent' }}
            data-status={b.status ?? 'none'}
          />
        );
      })}
    </div>
  );
}
