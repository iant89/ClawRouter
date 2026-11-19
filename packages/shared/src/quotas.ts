/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

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
  /** Whether this quota is enforced. Off keeps the settings without refusing anything. */
  enabled: boolean;
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
  enabled: true, unit: 'tokens', amount: 1_000_000, period: 'month', resetHour: 0, resetWeekday: 1, resetDayOfMonth: 1, timeZone: 'UTC',
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
  /** Whether quotas are enforced at all (the "Enforce user quotas" setting). */
  quotasEnabled: boolean;
  /** Whether this user's quota refuses requests now: a quota, turned on, with quotas enforced. */
  enforced: boolean;
}

/** PUT /api/users/:id/quota: null removes the quota. */
export interface PutUserQuotaRequest {
  quota: UserQuota | null;
}
