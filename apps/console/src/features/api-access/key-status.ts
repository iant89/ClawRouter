import type { ApiKeyStatus } from '@clawrouter/shared';

/** How each key status reads (never by color alone: every one has a label). */
export const KEY_STATUS: Record<ApiKeyStatus, { tone: 'success' | 'warning' | 'neutral'; label: string }> = {
  ACTIVE: { tone: 'success', label: 'Active' },
  SUSPENDED: { tone: 'warning', label: 'Suspended (owner disabled)' },
  EXPIRED: { tone: 'warning', label: 'Expired' },
  REVOKED: { tone: 'neutral', label: 'Revoked' },
};
