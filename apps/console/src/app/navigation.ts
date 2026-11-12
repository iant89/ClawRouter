/**
 * Console navigation (spec §17). Pure data so it can be tested and, from
 * Phase 3, filtered by the permissions returned by the server. Hiding an item
 * is never authorization: the server enforces access.
 */
import type { IconId } from '@enterprise-ui/react';

export type PageId =
  | 'dashboard'
  | 'requests' | 'api-access' | 'usage'
  | 'providers' | 'models' | 'routing'
  | 'health' | 'logs' | 'audit'
  | 'users' | 'roles' | 'sessions' | 'settings';

export interface NavItem {
  id: PageId;
  label: string;
  path: string;
  icon: IconId;
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
      { id: 'requests', label: 'Requests', path: '/requests', icon: 'activity-items', plannedPhase: 10, summary: 'Every gateway request with its routing decision, retries, failovers, duration and tokens.' },
      { id: 'api-access', label: 'API Access', path: '/api-access', icon: 'key', plannedPhase: 8, summary: 'API keys for external AI clients: scopes, allowed models, limits, expiry and revocation.' },
      { id: 'usage', label: 'Usage', path: '/usage', icon: 'line-chart', plannedPhase: 10, summary: 'Token usage and estimated cost by provider, model, client and user.' },
    ],
  },
  {
    id: 'ai',
    label: 'AI Infrastructure',
    items: [
      { id: 'providers', label: 'Providers', path: '/providers', icon: 'connected', plannedPhase: 5, summary: 'OpenAI, Anthropic, Google and local providers: configuration, credentials, connection tests and status.' },
      { id: 'models', label: 'Models', path: '/models', icon: 'it-instance', plannedPhase: 6, summary: 'The model registry: capabilities, context length, availability and cost metadata.' },
      { id: 'routing', label: 'Routing', path: '/routing', icon: 'split', plannedPhase: 7, summary: 'Aliases, priorities, weights, fallbacks and retry policies that decide where requests go.' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { id: 'health', label: 'Health', path: '/health', icon: 'electrocardiogram', summary: 'Health of every platform component.' },
      { id: 'logs', label: 'Logs', path: '/logs', icon: 'document-text', plannedPhase: 13, summary: 'Structured, redacted server logs with filtering by level, component, provider and request id.' },
      { id: 'audit', label: 'Audit', path: '/audit', icon: 'history', plannedPhase: 13, summary: 'Security-relevant actions: who changed what, when and from where.' },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [
      { id: 'users', label: 'Users', path: '/users', icon: 'group', plannedPhase: 14, summary: 'Console users, their status and role assignments.' },
      { id: 'roles', label: 'Roles', path: '/roles', icon: 'permission', plannedPhase: 3, summary: 'ADMIN, OPERATOR and VIEWER roles and their permissions.' },
      { id: 'sessions', label: 'Sessions', path: '/sessions', icon: 'user-settings', summary: 'Active console sessions, with revocation.' },
      { id: 'settings', label: 'Settings', path: '/settings', icon: 'settings', plannedPhase: 14, summary: 'System and security settings.' },
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
