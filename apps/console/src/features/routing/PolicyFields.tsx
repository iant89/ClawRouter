import { NumberInput, Select, WithFieldHelp } from '@enterprise-ui/react';
import { FAILOVER_POLICIES, MAX_ATTEMPTS_CEILING, type FailoverPolicy, type RoutingPolicy } from '@clawrouter/shared';
import { FAILOVER_LABEL } from './routing-utils.ts';

/** Failover policy inputs (spec §11), shared by the default policy and per-alias overrides. */
export function PolicyFields({ value, onChange, errors = {} }: {
  value: RoutingPolicy;
  onChange: (next: RoutingPolicy) => void;
  errors?: Partial<Record<keyof RoutingPolicy, string>>;
}) {
  const retries = value.failover === 'RETRY_SAME_PROVIDER' || value.failover === 'RETRY_AND_FAILOVER';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: 'var(--eui-space-3, 0.75rem)' }}>
      <WithFieldHelp
        label="When a model fails"
        help="A timeout, network error, rate limit (429) or server error from the provider. A request the provider rejects as invalid is not retried. A streamed answer can only move on before its first token."
      >
        <Select
          label="When a model fails"
          value={value.failover}
          onChange={(v) => v && onChange({ ...value, failover: v as FailoverPolicy })}
          options={FAILOVER_POLICIES.map((p) => ({ value: p, label: FAILOVER_LABEL[p] }))}
          error={errors.failover}
        />
      </WithFieldHelp>
      <WithFieldHelp label="Max attempts" help="Per request, retries and every model included. The plan stops here even if models are left.">
        <NumberInput
          label="Max attempts"
          description={`Allowed 1–${MAX_ATTEMPTS_CEILING}.`}
          min={1}
          max={MAX_ATTEMPTS_CEILING}
          step={1}
          value={value.maxAttempts}
          onChange={(n) => onChange({ ...value, maxAttempts: n ?? 1 })}
          error={errors.maxAttempts}
        />
      </WithFieldHelp>
      <WithFieldHelp label="Retries per model" help="Extra tries on the same model before moving on to the next one. Only used by the policies that retry.">
        <NumberInput
          label="Retries per model"
          description={retries ? 'Allowed 0–3.' : 'Not used by this policy.'}
          disabled={!retries}
          min={0}
          max={3}
          step={1}
          value={value.retriesPerTarget}
          onChange={(n) => onChange({ ...value, retriesPerTarget: n ?? 0 })}
          error={errors.retriesPerTarget}
        />
      </WithFieldHelp>
    </div>
  );
}
