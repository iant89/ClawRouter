import type { RequestRecord, RequestStatus } from '@clawrouter/shared';
import { formatTokens } from '../../services/format.ts';

export const STATUS: Record<RequestStatus, { tone: 'success' | 'warning' | 'error' | 'information' | 'neutral'; label: string }> = {
  EXECUTING: { tone: 'information', label: 'Running' },
  STREAMING: { tone: 'information', label: 'Streaming' },
  COMPLETED: { tone: 'success', label: 'Completed' },
  FAILED: { tone: 'error', label: 'Failed' },
  TIMEOUT: { tone: 'error', label: 'Timed out' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
};

/** "7 in · 4 out", prefixed with ≈ when counted locally because the provider reported nothing. */
export function describeTokens(r: Pick<RequestRecord, 'inputTokens' | 'outputTokens' | 'usageSource'>): string {
  if (r.inputTokens === null && r.outputTokens === null) return '—';
  const approx = r.usageSource === 'estimated' ? '≈ ' : '';
  return `${approx}${formatTokens(r.inputTokens ?? 0)} in · ${formatTokens(r.outputTokens ?? 0)} out`;
}

/** "1", "3 (1 retry, 1 failover)" */
export function describeAttempts(r: Pick<RequestRecord, 'attempts' | 'retries' | 'failovers'>): string {
  const extra: string[] = [];
  if (r.retries) extra.push(`${r.retries} ${r.retries === 1 ? 'retry' : 'retries'}`);
  if (r.failovers) extra.push(`${r.failovers} ${r.failovers === 1 ? 'failover' : 'failovers'}`);
  return extra.length ? `${r.attempts} (${extra.join(', ')})` : String(r.attempts);
}

/** Readable attempt outcomes (the executor's failure kinds). */
export const OUTCOME_LABEL: Record<string, string> = {
  ok: 'Succeeded',
  skipped_rate_limit: 'Skipped: model at its rate limit',
  timeout: 'Timed out',
  unreachable: 'Provider unreachable',
  server_error: 'Provider error (5xx)',
  rate_limited: "Provider's rate limit (429)",
  invalid_response: 'Unreadable response',
  auth: 'Credentials rejected',
  not_found: 'Model not found at the provider',
  bad_request: 'Request rejected by the provider',
  cancelled: 'Cancelled',
  unavailable: 'Provider not available',
  internal: 'Internal error',
};

export const outcomeLabel = (kind: string) => OUTCOME_LABEL[kind] ?? kind;
