import { KEY_EXPIRY_MAX_HOURS } from '@clawrouter/shared';
import type { Validator } from '@clawrouter/core';

/**
 * Maximum API key lifetime in hours for providers and models: absent leaves it
 * unchanged, null removes the limit. Ranges are checked again by the services.
 */
export const keyLifetimeHours: Validator<number | null | undefined> = (value, path, issues) => {
  if (value === undefined || value === null) return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= KEY_EXPIRY_MAX_HOURS) return value;
  issues.push({ path, message: `must be a whole number of hours from 1 to ${KEY_EXPIRY_MAX_HOURS}, or null for no limit` });
  return undefined;
};
