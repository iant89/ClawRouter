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

import type { AuditService } from '@clawrouter/audit';
import type { ApiKeyService } from '@clawrouter/gateway';
import type { HealthService } from '@clawrouter/health';
import type { ModelService } from '@clawrouter/models';
import type { ProviderService } from '@clawrouter/providers';
import type { QuotaService, RateLimitService } from '@clawrouter/rate-limits';
import type { RequestLogService } from '@clawrouter/requests';
import {
  AUDIT_ACTIONS, CAPABILITIES, REQUEST_STATUSES, USAGE_GROUPS,
  type AuditAction, type Capability, type Permission, type RequestStatus, type UsageGroup,
} from '@clawrouter/shared';

/** Everything the tools read. Each tool reads through the same services as the console's API. */
export interface McpToolServices {
  health: HealthService;
  requests: RequestLogService;
  providers: ProviderService;
  models: ModelService;
  audit: AuditService;
  limits: RateLimitService;
  quotas: QuotaService;
  apiKeys: ApiKeyService;
  /** The services' clock, so look-backs such as "24h" agree with them. */
  now: () => Date;
}

/** Who a tool call acts for: the key's owner, with their permissions as they are now. */
export interface McpCaller {
  userId: string;
  permissions: ReadonlySet<Permission>;
}

/** A tool argument the caller got wrong; reported to the model as a tool error, so it can correct itself. */
export class ToolInputError extends Error {}

type Args = Record<string, unknown>;

export interface McpTool {
  name: string;
  title: string;
  description: string;
  /** Needed to see and call the tool; null: any key owner (their own data only). */
  permission: Permission | null;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  run(args: Args, caller: McpCaller, services: McpToolServices): unknown | Promise<unknown>;
}

// --- argument readers: the schema is advice to the model, these are the rules ---

function str(args: Args, name: string, max = 300): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new ToolInputError(`"${name}" must be text of at most ${max} characters.`);
  return value.trim() || undefined;
}

function oneOf<T extends string>(args: Args, name: string, allowed: readonly T[]): T | undefined {
  const value = str(args, name, 100);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new ToolInputError(`"${name}" must be one of: ${allowed.join(', ')}.`);
  return value as T;
}

function int(args: Args, name: string, fallback: number, min: number, max: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ToolInputError(`"${name}" must be a whole number from ${min} to ${max}.`);
  return value;
}

function bool(args: Args, name: string): boolean {
  const value = args[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new ToolInputError(`"${name}" must be true or false.`);
  return value;
}

/** An ISO date-time, or a look-back such as "24h" or "7d" (from now). */
function when(args: Args, name: string, now: Date): string | undefined {
  const value = str(args, name, 40);
  if (value === undefined) return undefined;
  const back = /^(\d{1,4})([hd])$/.exec(value);
  if (back) return new Date(now.getTime() - Number(back[1]) * (back[2] === 'h' ? 3_600_000 : 86_400_000)).toISOString();
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ToolInputError(`"${name}" must be an ISO date-time (2026-11-16T09:00:00Z) or a look-back such as "24h" or "7d".`);
  return new Date(t).toISOString();
}

const WHEN = (what: string) => ({ type: 'string', description: `${what}: an ISO date-time, or a look-back from now such as "24h" or "7d".` });
const LIMIT = (fallback: number, max: number) => ({ type: 'integer', minimum: 1, maximum: max, default: fallback, description: `How many to return (at most ${max}).` });
const PAGE = { type: 'integer', minimum: 1, default: 1, description: 'Page number, for more results.' };

const page = <T>(r: { items: T[]; total: number; page: number; pageSize: number }) => ({
  items: r.items, total: r.total, page: r.page, pageSize: r.pageSize, more: r.page * r.pageSize < r.total,
});

/**
 * The tools ClawRouter's MCP server offers. All of them only read: an agent can
 * ask about ClawRouter but not change it (no tool creates keys, so no secret is
 * ever written into an agent's conversation). Each needs the same permission as
 * the console page it mirrors.
 */
export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'get_health',
    title: 'Platform health',
    description: 'ClawRouter\'s health now: overall status (HEALTHY, DEGRADED, OFFLINE) and each component (database, providers, gateway, ...) with details and latency.',
    permission: 'health.read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, _caller, s) => s.health.report(),
  },
  {
    name: 'get_usage',
    title: 'Usage and cost',
    description: 'Requests, tokens and estimated cost (USD) over a period, with totals and a breakdown by model, provider, API key or user. Use it for questions like "what did we spend this week?" or "which key uses the most tokens?".',
    permission: 'usage.read',
    inputSchema: {
      type: 'object',
      properties: {
        from: WHEN('Start of the period (default: 24 hours ago)'),
        to: WHEN('End of the period (default: now)'),
        groupBy: { type: 'string', enum: [...USAGE_GROUPS], description: 'Break the totals down by this (default: model).' },
        includeSeries: { type: 'boolean', default: false, description: 'Also return hourly or daily buckets (for trends; larger answer).' },
      },
      additionalProperties: false,
    },
    run: (args, _caller, s) => {
      const now = s.now();
      const report = s.requests.usage({ from: when(args, 'from', now), to: when(args, 'to', now), groupBy: oneOf<UsageGroup>(args, 'groupBy', USAGE_GROUPS) });
      if (bool(args, 'includeSeries')) return report;
      const { series: _series, ...rest } = report;
      return rest;
    },
  },
  {
    name: 'list_requests',
    title: 'Recent requests',
    description: 'Requests that went through the gateway, newest first: status, model asked for and model that answered, provider, duration, tokens, cost, retries, failovers and the error, if any. Metadata only: prompts and answers are never stored.',
    permission: 'requests.read',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...REQUEST_STATUSES], description: 'Only requests with this status.' },
        problemsOnly: { type: 'boolean', default: false, description: 'Only failed requests and those that needed retries or failover.' },
        model: { type: 'string', description: 'Only requests for this model (as asked for, or as answered).' },
        from: WHEN('Received at or after'),
        to: WHEN('Received before'),
        limit: LIMIT(20, 50),
        page: PAGE,
      },
      additionalProperties: false,
    },
    run: (args, _caller, s) => {
      const now = s.now();
      return page(s.requests.list({
        page: int(args, 'page', 1, 1, 1_000_000), pageSize: int(args, 'limit', 20, 1, 50),
        status: oneOf<RequestStatus>(args, 'status', REQUEST_STATUSES), model: str(args, 'model'),
        from: when(args, 'from', now), to: when(args, 'to', now), problemsOnly: bool(args, 'problemsOnly'),
      }));
    },
  },
  {
    name: 'get_request',
    title: 'One request in detail',
    description: 'One gateway request with every attempt it made (provider, model, outcome, latency): use it to see why a request failed or failed over. The id comes from list_requests or a response\'s x-request-id header.',
    permission: 'requests.read',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The request id.' } }, required: ['id'], additionalProperties: false },
    run: (args, _caller, s) => {
      const id = str(args, 'id', 64);
      if (!id) throw new ToolInputError('"id" is required.');
      return s.requests.get(id);
    },
  },
  {
    name: 'list_providers',
    title: 'Providers',
    description: 'The AI providers ClawRouter routes to (OpenAI, Anthropic, Google, Groq, compatible servers): kind, endpoint, whether enabled, health, priority and whether a credential is set. Credentials themselves are never shown.',
    permission: 'providers.read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, _caller, s) => ({ items: s.providers.list() }),
  },
  {
    name: 'list_models',
    title: 'Models',
    description: 'Models in the registry, by provider priority: reference to use in requests (provider/model), capabilities, context window, prices per million tokens and whether usable now.',
    permission: 'models.read',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search names and ids.' },
        capability: { type: 'string', enum: [...CAPABILITIES], description: 'Only models with this capability.' },
        usableOnly: { type: 'boolean', default: false, description: 'Only models that can take requests now (enabled, provider enabled and healthy enough).' },
        limit: LIMIT(50, 200),
        page: PAGE,
      },
      additionalProperties: false,
    },
    run: (args, _caller, s) => page(s.models.list({
      page: int(args, 'page', 1, 1, 1_000_000), pageSize: int(args, 'limit', 50, 1, 200),
      q: str(args, 'q', 200), capability: oneOf<Capability>(args, 'capability', CAPABILITIES), usableOnly: bool(args, 'usableOnly'),
    })),
  },
  {
    name: 'get_rate_limits',
    title: 'Rate limits',
    description: 'The configured rate limits: default per API key, per user, global, per model, concurrency and the invalid-key limit per address.',
    permission: 'rate_limits.read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, _caller, s) => s.limits.get(),
  },
  {
    name: 'search_audit',
    title: 'Audit log',
    description: 'Search the audit log of administrative actions and sign-ins, newest first: who did what to which resource, when, from where, and whether it succeeded.',
    permission: 'audit.read',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Free text (names, resource ids, details).' },
        action: { type: 'string', enum: [...AUDIT_ACTIONS], description: 'Only this action.' },
        result: { type: 'string', enum: ['SUCCESS', 'FAILURE'] },
        actor: { type: 'string', description: 'Only actions by this username.' },
        from: WHEN('At or after'),
        to: WHEN('Before'),
        limit: LIMIT(20, 50),
        page: PAGE,
      },
      additionalProperties: false,
    },
    run: (args, _caller, s) => {
      const now = s.now();
      const r = s.audit.search({
        page: int(args, 'page', 1, 1, 1_000_000), pageSize: int(args, 'limit', 20, 1, 50),
        q: str(args, 'q'), action: oneOf<AuditAction>(args, 'action', AUDIT_ACTIONS), result: oneOf(args, 'result', ['SUCCESS', 'FAILURE'] as const),
        actor: str(args, 'actor', 64), from: when(args, 'from', now), to: when(args, 'to', now),
      });
      return page(r);
    },
  },
  {
    name: 'get_my_quota',
    title: 'My quota',
    description: 'Your own usage quota (the owner of this API key): how much you may use, how much is used in the current period and when it resets.',
    permission: null,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, caller, s) => s.quotas.get(caller.userId),
  },
  {
    name: 'list_my_api_keys',
    title: 'My API keys',
    description: 'Your own API keys (the owner of this key): name, prefix, allowed models, status, expiry and last use. Secrets are never shown.',
    permission: null,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, caller, s) => ({ items: s.apiKeys.listOwned(caller.userId) }),
  },
];

export const allowedTools = (caller: McpCaller) => MCP_TOOLS.filter((t) => t.permission === null || caller.permissions.has(t.permission));
