/**
 * Usage quotas per user: how much one user's API keys may use, combined, in a
 * day, week or month. Unlike rate limits (which smooth traffic over seconds to
 * hours) a quota is a budget; when it is used up, the user's keys are refused
 * until the period resets.
 */
export const QUOTA_UNITS = ['tokens', 'requests', 'cost'] as const;
/** `tokens`: input + output tokens. `requests`: completed requests. `cost`: estimated US dollars. */
export type QuotaUnit = (typeof QUOTA_UNITS)[number];

export const QUOTA_PERIODS = ['day', 'week', 'month'] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

export interface UserQuota {
  unit: QuotaUnit;
  /** Allowed per period: tokens, requests, or US dollars (two decimals). */
  amount: number;
  period: QuotaPeriod;
  /** Hour of the day (0–23) the period starts, in `timeZone`. */
  resetHour: number;
  /** For `week`: the day it starts, 1 = Monday … 7 = Sunday. */
  resetWeekday: number;
  /** For `month`: the day of the month it starts, 1–28. */
  resetDayOfMonth: number;
  /** IANA time zone the reset time is in, e.g. Europe/London. */
  timeZone: string;
}

export const QUOTA_AMOUNT_MAX = 1_000_000_000_000;

export const DEFAULT_QUOTA: UserQuota = {
  unit: 'tokens', amount: 1_000_000, period: 'month', resetHour: 0, resetWeekday: 1, resetDayOfMonth: 1, timeZone: 'UTC',
};

/** Where a user stands in the current period. */
export interface QuotaUsage {
  used: number;
  /** Equal to the quota's amount. */
  limit: number;
  /** Start of the current period and the next reset (ISO date-times). */
  periodStart: string;
  resetsAt: string;
}

/** GET /api/users/:id/quota and GET /api/me/quota */
export interface UserQuotaView {
  userId: string;
  quota: UserQuota | null;
  /** Null when the user has no quota. */
  usage: QuotaUsage | null;
}

/** PUT /api/users/:id/quota: null removes the quota. */
export interface PutUserQuotaRequest {
  quota: UserQuota | null;
}
