import { NumberInput, Select } from '@enterprise-ui/react';
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
      <Select
        label="When a model fails"
        value={value.failover}
        onChange={(v) => v && onChange({ ...value, failover: v as FailoverPolicy })}
        options={FAILOVER_POLICIES.map((p) => ({ value: p, label: FAILOVER_LABEL[p] }))}
        error={errors.failover}
      />
      <NumberInput
        label="Max attempts"
        description={`Per request, all models included (1–${MAX_ATTEMPTS_CEILING}).`}
        min={1}
        max={MAX_ATTEMPTS_CEILING}
        step={1}
        value={value.maxAttempts}
        onChange={(n) => onChange({ ...value, maxAttempts: n ?? 1 })}
        error={errors.maxAttempts}
      />
      <NumberInput
        label="Retries per model"
        description={retries ? 'Extra tries before moving on (0–3).' : 'Not used by this policy.'}
        disabled={!retries}
        min={0}
        max={3}
        step={1}
        value={value.retriesPerTarget}
        onChange={(n) => onChange({ ...value, retriesPerTarget: n ?? 0 })}
        error={errors.retriesPerTarget}
      />
    </div>
  );
}
