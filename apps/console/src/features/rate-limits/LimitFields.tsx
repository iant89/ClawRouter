import { NumberInput } from '@enterprise-ui/react';
import { RATE_LIMIT_MAX, type RateLimit } from '@clawrouter/shared';

/** Requests and tokens per minute; an empty field means no limit. */
export function LimitFields({ value, onChange, errors = {}, disabled, labelPrefix = '' }: {
  value: RateLimit;
  onChange: (next: RateLimit) => void;
  errors?: Partial<Record<keyof RateLimit, string>>;
  disabled?: boolean;
  /** Prefixed to the labels when several groups share a page, e.g. "Per key: ". */
  labelPrefix?: string;
}) {
  return (
    <>
      <NumberInput
        label={`${labelPrefix}Requests per minute`}
        placeholder="No limit"
        min={1}
        max={RATE_LIMIT_MAX}
        step={1}
        value={value.requestsPerMinute}
        onChange={(n) => onChange({ ...value, requestsPerMinute: n })}
        error={errors.requestsPerMinute}
        disabled={disabled}
      />
      <NumberInput
        label={`${labelPrefix}Tokens per minute`}
        placeholder="No limit"
        min={1}
        max={RATE_LIMIT_MAX}
        step={1000}
        value={value.tokensPerMinute}
        onChange={(n) => onChange({ ...value, tokensPerMinute: n })}
        error={errors.tokensPerMinute}
        disabled={disabled}
      />
    </>
  );
}
