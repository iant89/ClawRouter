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
 * Console navigation (spec §17). Pure data so it can be tested and, from
 * Phase 3, filtered by the permissions returned by the server. Hiding an item
 * is never authorization: the server enforces access.
 */
import type { IconId } from '@enterprise-ui/react';
import type { Permission } from '@clawrouter/shared';

export type PageId =
  | 'dashboard'
  | 'requests' | 'api-access' | 'my-keys' | 'playground' | 'rate-limits' | 'usage'
  | 'providers' | 'models' | 'routing'
  | 'health' | 'operations' | 'logs' | 'audit' | 'captures'
  | 'announcements' | 'users' | 'roles' | 'sessions' | 'settings';

export interface NavItem {
  id: PageId;
  label: string;
  path: string;
  icon: IconId;
  /** Permission needed to see the page. Hiding it is a convenience; the server enforces access. */
  permission?: Permission;
  /** Roadmap phase that delivers the page. Pages without one are implemented. */
  plannedPhase?: number;
  /** One-line description shown on the placeholder page. */
  summary: string;
}

export interface NavGroup {
  id: string;
  label: string | null;
  items: NavItem[];
}

export const NAVIGATION: readonly NavGroup[] = [
  {
    id: 'home',
    label: null,
    items: [{ id: 'dashboard', label: 'Dashboard', path: '/', icon: 'home', summary: 'Is the AI gateway working?' }],
  },
  {
    id: 'gateway',
    label: 'Gateway',
    items: [
      { id: 'requests', permission: 'requests.read', label: 'Requests', path: '/requests', icon: 'activity-items', summary: 'Every gateway request with its routing decision, retries, failovers, duration and tokens.' },
      { id: 'api-access', permission: 'api_keys.read', label: 'API Access', path: '/api-access', icon: 'key', summary: 'API keys for external AI clients: scopes, allowed models, limits, expiry and revocation.' },
      { id: 'my-keys', label: 'My API keys', path: '/my-keys', icon: 'key-user-settings', summary: 'Your own API keys, and requests for keys when you may not create them.' },
      { id: 'playground', permission: 'playground.use', label: 'Playground', path: '/playground', icon: 'discussion', summary: 'Chat with a model through the gateway as one of your API keys, and set up chat apps such as Open WebUI and LibreChat.' },
      { id: 'rate-limits', permission: 'rate_limits.read', label: 'Rate Limits', path: '/rate-limits', icon: 'performance', summary: 'Requests and tokens per minute per key, user, model and gateway, and live usage.' },
      { id: 'usage', permission: 'usage.read', label: 'Usage', path: '/usage', icon: 'line-chart', summary: 'Token usage and estimated cost by provider, model, client and user.' },
    ],
  },
  {
    id: 'ai',
    label: 'AI Infrastructure',
    items: [
      { id: 'providers', permission: 'providers.read', label: 'Providers', path: '/providers', icon: 'connected', summary: 'OpenAI, Anthropic, Google and local providers: configuration, credentials, connection tests and status.' },
      { id: 'models', permission: 'models.read', label: 'Models', path: '/models', icon: 'it-instance', summary: 'The model registry: capabilities, context length, availability and cost metadata.' },
      { id: 'routing', permission: 'routing.read', label: 'Routing', path: '/routing', icon: 'split', summary: 'Aliases, priorities, weights, fallbacks and retry policies that decide where requests go.' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { id: 'health', permission: 'health.read', label: 'Health', path: '/health', icon: 'electrocardiogram', summary: 'Health of every platform component.' },
      { id: 'operations', permission: 'health.read', label: 'Operations', path: '/operations', icon: 'in-progress', summary: 'Long-running work such as connection tests and checks, with progress and cancellation.' },
      { id: 'logs', permission: 'logs.read', label: 'Logs', path: '/logs', icon: 'document-text', summary: 'Structured, redacted server logs with filtering by level, component, provider and request id.' },
      { id: 'audit', permission: 'audit.read', label: 'Audit', path: '/audit', icon: 'history', summary: 'Security-relevant actions: who changed what, when and from where.' },
      { id: 'captures', permission: 'captures.manage', label: 'Captures', path: '/captures', icon: 'record', summary: 'Requests that went wrong with a provider, recorded in full and exported to a file for a developer.' },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [
      { id: 'announcements', permission: 'announcements.manage', label: 'Announcements', path: '/announcements', icon: 'message-information', summary: 'Messages for API users, sent with their responses on a schedule: every request, once, daily or weekly.' },
      { id: 'users', permission: 'users.read', label: 'Users', path: '/users', icon: 'group', summary: 'Console users and their roles.' },
      { id: 'roles', permission: 'roles.read', label: 'Roles', path: '/roles', icon: 'permission', summary: 'Roles and the permissions they grant.' },
      { id: 'sessions', permission: 'sessions.read', label: 'Sessions', path: '/sessions', icon: 'user-settings', summary: 'Active console sessions, with revocation.' },
      { id: 'settings', permission: 'settings.read', label: 'Settings', path: '/settings', icon: 'settings', summary: 'Sign-in and sessions, API keys, mail server, data retention, and configuration import and export.' },
    ],
  },
];

export const NAV_ITEMS: readonly NavItem[] = NAVIGATION.flatMap((g) => g.items);

/** Resolves a pathname to a navigation item; trailing slashes are ignored. */
export function resolvePath(pathname: string): NavItem | undefined {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return NAV_ITEMS.find((item) => item.path === normalized);
}

export function itemById(id: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.id === id);
}

const NONE: ReadonlySet<PageId> = new Set();

/** Pages an administrator turned off for everyone in Settings (the session says which). */
export function switchedOff(session: { playground: boolean }): ReadonlySet<PageId> {
  return session.playground ? NONE : new Set<PageId>(['playground']);
}

/** True when the page is not switched off and needs no permission or the user holds it. */
export function canSee(item: NavItem, permissions: ReadonlySet<string>, off: ReadonlySet<PageId> = NONE): boolean {
  return !off.has(item.id) && (item.permission === undefined || permissions.has(item.permission));
}

/** Navigation filtered to what the user may open; empty groups are dropped. */
export function visibleNavigation(permissions: ReadonlySet<string>, off: ReadonlySet<PageId> = NONE): NavGroup[] {
  return NAVIGATION.map((g) => ({ ...g, items: g.items.filter((i) => canSee(i, permissions, off)) })).filter((g) => g.items.length > 0);
}
