import { StatusIndicator } from '@enterprise-ui/react';
import type { ModelInfo } from '@clawapi/shared';

/**
 * Whether a model can receive requests, and why not. Combines the model's own
 * availability with its provider's (spec §9), always as text.
 */
export function ModelAvailability({ model }: { model: Pick<ModelInfo, 'usable' | 'unusableReason' | 'availability'> }) {
  if (model.usable) {
    return model.availability === 'AVAILABLE'
      ? <StatusIndicator tone="success" size="sm">Usable</StatusIndicator>
      : <StatusIndicator tone="information" size="sm">Usable (not verified)</StatusIndicator>;
  }
  const tone = model.unusableReason?.includes('disabled') ? 'neutral' : 'warning';
  return <StatusIndicator tone={tone} size="sm">{model.unusableReason ?? 'Unusable'}</StatusIndicator>;
}
