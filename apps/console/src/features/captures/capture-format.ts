import type { CaptureTrigger } from '@clawrouter/shared';

export const TRIGGER_TONE: Record<CaptureTrigger, 'error' | 'warning' | 'information'> = {
  error: 'error',
  parse_error: 'warning',
  manual: 'information',
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
