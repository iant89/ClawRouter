import { NumberInput, Select, Switch, WithFieldHelp } from '@enterprise-ui/react';
import { BUCKET_CAPACITY_MAX, BUCKET_REFILL_SECONDS_MAX, RATE_LIMIT_MAX, type RateLimit, type RateWindow, type TokenBucket } from '@clawrouter/shared';

const WINDOW_OPTIONS: { value: RateWindow; label: string }[] = [
  { value: 'second', label: 'Per second' },
  { value: 'minute', label: 'Per minute' },
  { value: 'hour', label: 'Per hour' },
];

export const DEFAULT_BUCKET: TokenBucket = { capacity: 10, refillAmount: 1, refillEverySeconds: 1 };

/** Validation messages by field: `window`, `requests`, `tokens`, `bucket.capacity`, ... */
export type LimitErrors = Partial<Record<'window' | 'requests' | 'tokens' | 'bucket.capacity' | 'bucket.refillAmount' | 'bucket.refillEverySeconds', string>>;

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)', alignItems: 'start' } as const;

/**
 * One rate limit: the window (second, minute or hour), requests and tokens per
 * window (empty = no limit), and an optional token bucket against bursts.
 */
export function LimitFields({ value, onChange, errors = {}, disabled, labelPrefix = '' }: {
  value: RateLimit;
  onChange: (next: RateLimit) => void;
  errors?: LimitErrors;
  disabled?: boolean;
  /** Prefixed to the labels when several groups share a page, e.g. "Per key: ". */
  labelPrefix?: string;
}) {
  const per = value.window;
  const setBucket = (patch: Partial<TokenBucket>) => onChange({ ...value, bucket: { ...(value.bucket ?? DEFAULT_BUCKET), ...patch } });
  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
      <div style={grid}>
        <WithFieldHelp label={`${labelPrefix}Window`} help="How long requests and tokens are counted for. The window slides: a request counts for exactly one second, minute or hour after it was made.">
          <Select label={`${labelPrefix}Window`} value={value.window} options={WINDOW_OPTIONS} disabled={disabled} error={errors.window}
            onChange={(v) => v && onChange({ ...value, window: v as RateWindow })} />
        </WithFieldHelp>
        <NumberInput label={`${labelPrefix}Requests per ${per}`} placeholder="No limit" description="Empty = no limit"
          min={1} max={RATE_LIMIT_MAX} step={1} value={value.requests} disabled={disabled} error={errors.requests}
          onChange={(n) => onChange({ ...value, requests: n })} />
        <WithFieldHelp label={`${labelPrefix}Tokens per ${per}`} help="Input and output tokens reported by the provider. They are counted when an answer ends, so one large request can go past the limit; the next one waits.">
          <NumberInput label={`${labelPrefix}Tokens per ${per}`} placeholder="No limit" description="Empty = no limit"
            min={1} max={RATE_LIMIT_MAX} step={1000} value={value.tokens} disabled={disabled} error={errors.tokens}
            onChange={(n) => onChange({ ...value, tokens: n })} />
        </WithFieldHelp>
      </div>
      <WithFieldHelp label={`${labelPrefix}Limit bursts`} help="A token bucket stops a client from spamming the API. The bucket starts full; each request takes one. At every refill the amount is added back, never above the capacity. Capacity is the largest burst; amount ÷ interval is the steady rate.">
        <Switch label={`${labelPrefix}Limit bursts (token bucket)`} checked={value.bucket !== null} disabled={disabled}
          onChange={(on) => onChange({ ...value, bucket: on ? (value.bucket ?? DEFAULT_BUCKET) : null })} />
      </WithFieldHelp>
      {value.bucket && (
        <div style={grid}>
          <NumberInput label={`${labelPrefix}Bucket capacity`} description="Largest burst, in requests" min={1} max={BUCKET_CAPACITY_MAX} step={1}
            value={value.bucket.capacity} disabled={disabled} error={errors['bucket.capacity']}
            onChange={(n) => setBucket({ capacity: n ?? 1 })} />
          <WithFieldHelp label={`${labelPrefix}Refill amount`} help="Requests added back to the bucket at once at each refill. At most the capacity.">
            <NumberInput label={`${labelPrefix}Refill amount`} description="Requests added at each refill" min={1} max={value.bucket.capacity} step={1}
              value={value.bucket.refillAmount} disabled={disabled} error={errors['bucket.refillAmount']}
              onChange={(n) => setBucket({ refillAmount: n ?? 1 })} />
          </WithFieldHelp>
          <NumberInput label={`${labelPrefix}Refill every`} description="Seconds between refills" unit="s" min={1} max={BUCKET_REFILL_SECONDS_MAX} step={1}
            value={value.bucket.refillEverySeconds} disabled={disabled} error={errors['bucket.refillEverySeconds']}
            onChange={(n) => setBucket({ refillEverySeconds: n ?? 1 })} />
        </div>
      )}
    </div>
  );
}

/** Errors for one limit from the server's issues, by the limit's path (e.g. "perKey"). */
export function limitErrors(issue: (path: string) => string | undefined, path: string): LimitErrors {
  const out: LimitErrors = {};
  for (const f of ['window', 'requests', 'tokens', 'bucket.capacity', 'bucket.refillAmount', 'bucket.refillEverySeconds'] as const) out[f] = issue(`${path}.${f}`);
  return out;
}
