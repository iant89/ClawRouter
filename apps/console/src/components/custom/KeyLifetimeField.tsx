import { useEffect, useId, useState, type ReactNode } from 'react';
import { NumberInput, Select, Text, WithFieldHelp } from '@enterprise-ui/react';
import { KEY_EXPIRY_MAX_HOURS } from '@clawrouter/shared';

type Unit = 'hours' | 'days';

/**
 * Maximum API key lifetime for a provider or model (owner's request), in hours.
 * Blank means no limit. Shown as hours or days; the server stores hours.
 */
export function KeyLifetimeField({ value, onChange, error, description = 'Optional. Blank: no limit.', help }: {
  value: number | null;
  onChange: (hours: number | null) => void;
  error?: string;
  /** Short note under the field. */
  description?: string;
  /** What the limit does, in the "i" tip beside the field. */
  help?: ReactNode;
}) {
  const helpId = useId();
  const [unit, setUnit] = useState<Unit>(value !== null && value % 24 !== 0 ? 'hours' : 'days');
  useEffect(() => {
    if (value !== null && value % 24 !== 0) setUnit('hours');
  }, [value]);
  const amount = value === null ? null : unit === 'days' ? value / 24 : value;
  const max = unit === 'days' ? KEY_EXPIRY_MAX_HOURS / 24 : KEY_EXPIRY_MAX_HOURS;

  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-1, 0.25rem)' }}>
      {/* Number and unit side by side at a fixed width, the "i" beside them; the note below. */}
      <WithFieldHelp label="Maximum key lifetime" inline help={help ?? 'API keys that use this must expire within it, and older keys stop working here.'}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(9rem, 13rem) minmax(7rem, 9rem)', gap: 'var(--eui-space-2, 0.5rem)', alignItems: 'start' }}>
        <NumberInput
          label="Maximum key lifetime"
          aria-describedby={helpId}
          placeholder="No limit"
          min={1}
          max={max}
          step={1}
          value={amount}
          onChange={(n) => onChange(n === null ? null : Math.round(n) * (unit === 'days' ? 24 : 1))}
          error={error}
        />
        <Select<Unit>
          label="Unit"
          value={unit}
          onChange={(u) => {
            if (!u) return;
            setUnit(u);
            // Keep the number the user typed, in the new unit.
            if (amount !== null) onChange(Math.max(1, Math.round(amount)) * (u === 'days' ? 24 : 1));
          }}
          options={[{ value: 'days', label: 'Days' }, { value: 'hours', label: 'Hours' }]}
        />
      </div>
      </WithFieldHelp>
      <Text id={helpId} size="sm" tone="secondary">
        {description}
      </Text>
    </div>
  );
}
