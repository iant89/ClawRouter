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

import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { BusyIndicator, Button, EmptyState, ErrorBoundary, ToastProvider, type ErrorBoundaryLabels } from '@enterprise-ui/react';
import { ThemeChoiceProvider } from '../features/appearance/ThemeChoice.tsx';
import { HealthProvider } from '../features/health/HealthContext.tsx';
import { RealtimeProvider } from '../features/realtime/RealtimeContext.tsx';
import { DisabledPage } from '../pages/DisabledPage.tsx';
import { NoAccessPage } from '../pages/NoAccessPage.tsx';
import { AuthProvider, useAuth, usePermissions, useSession } from '../features/auth/AuthContext.tsx';
import { redirectFor } from '../features/auth/auth-state.ts';
import { LoginPage } from '../features/auth/LoginPage.tsx';
import { SetupPage } from '../features/auth/SetupPage.tsx';
import { ForcedPasswordChange } from '../features/auth/ForcedPasswordChange.tsx';
import { ForcedTwoFactorSetup } from '../features/auth/ForcedTwoFactorSetup.tsx';
import { PlannedFeature } from '../components/custom/PlannedFeature.tsx';
import { NotificationsProvider } from '../features/notifications/NotificationsContext.tsx';
import { ConsoleLayout } from '../layouts/ConsoleLayout.tsx';
import { NotFoundPage } from '../pages/NotFoundPage.tsx';
import { canSee, resolvePath, switchedOff, type NavItem } from './navigation.ts';
import { RouterProvider, useRouter } from './router.tsx';

/**
 * A page that crashes leaves the shell, navigation and header usable. Pages load on first
 * visit (phase 16): after ClawRouter is upgraded, an open console asks for page files that
 * no longer exist, and ErrorBoundary then offers only a reload.
 */
const PAGE_ERROR_LABELS: Partial<ErrorBoundaryLabels> = {
  title: 'This page could not be displayed',
  description: 'The rest of the console still works. Try again, or open another page. If it keeps happening, reload the console.',
  updatedTitle: 'ClawRouter was updated',
  updatedDescription: 'A newer version of the console is available. Reload to open this page.',
  reload: 'Reload console',
};

/**
 * Console pages load on first visit (phase 16): each is its own file, so signing in
 * does not wait for every page's code.
 */
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}

const DashboardPage = page(() => import('../features/dashboard/DashboardPage.tsx'), 'DashboardPage');
const HealthPage = page(() => import('../features/health/HealthPage.tsx'), 'HealthPage');
const SessionsPage = page(() => import('../features/sessions/SessionsPage.tsx'), 'SessionsPage');
const RolesPage = page(() => import('../features/roles/RolesPage.tsx'), 'RolesPage');
const UsersPage = page(() => import('../features/users/UsersPage.tsx'), 'UsersPage');
const ProvidersPage = page(() => import('../features/providers/ProvidersPage.tsx'), 'ProvidersPage');
const ModelsPage = page(() => import('../features/models/ModelsPage.tsx'), 'ModelsPage');
const RoutingPage = page(() => import('../features/routing/RoutingPage.tsx'), 'RoutingPage');
const ApiAccessPage = page(() => import('../features/api-access/ApiAccessPage.tsx'), 'ApiAccessPage');
const MyKeysPage = page(() => import('../features/my-keys/MyKeysPage.tsx'), 'MyKeysPage');
const PlaygroundPage = page(() => import('../features/playground/PlaygroundPage.tsx'), 'PlaygroundPage');
const RateLimitsPage = page(() => import('../features/rate-limits/RateLimitsPage.tsx'), 'RateLimitsPage');
const RequestsPage = page(() => import('../features/requests/RequestsPage.tsx'), 'RequestsPage');
const UsagePage = page(() => import('../features/usage/UsagePage.tsx'), 'UsagePage');
const OperationsPage = page(() => import('../features/operations/OperationsPage.tsx'), 'OperationsPage');
const LogsPage = page(() => import('../features/logs/LogsPage.tsx'), 'LogsPage');
const AuditPage = page(() => import('../features/audit/AuditPage.tsx'), 'AuditPage');
const CapturesPage = page(() => import('../features/captures/CapturesPage.tsx'), 'CapturesPage');
const AnnouncementsPage = page(() => import('../features/announcements/AnnouncementsPage.tsx'), 'AnnouncementsPage');
const SettingsPage = page(() => import('../features/settings/SettingsPage.tsx'), 'SettingsPage');
const SetupWizard = page(() => import('../features/onboarding/SetupWizard.tsx'), 'SetupWizard');

function PageFor({ item }: { item: NavItem | undefined }) {
  const { set } = usePermissions();
  const off = switchedOff(useSession());
  if (!item) return <NotFoundPage />;
  // Turned off in Settings, for everyone: say so rather than "not found".
  if (off.has(item.id)) return <DisabledPage item={item} />;
  if (!canSee(item, set)) return <NoAccessPage item={item} />;
  if (item.plannedPhase !== undefined) return <PlannedFeature item={item} />;
  switch (item.id) {
    case 'dashboard': return <DashboardPage />;
    case 'health': return <HealthPage />;
    case 'sessions': return <SessionsPage />;
    case 'users': return <UsersPage />;
    case 'providers': return <ProvidersPage />;
    case 'models': return <ModelsPage />;
    case 'routing': return <RoutingPage />;
    case 'api-access': return <ApiAccessPage />;
    case 'my-keys': return <MyKeysPage />;
    case 'playground': return <PlaygroundPage />;
    case 'rate-limits': return <RateLimitsPage />;
    case 'requests': return <RequestsPage />;
    case 'usage': return <UsagePage />;
    case 'operations': return <OperationsPage />;
    case 'logs': return <LogsPage />;
    case 'audit': return <AuditPage />;
    case 'captures': return <CapturesPage />;
    case 'announcements': return <AnnouncementsPage />;
    case 'roles': return <RolesPage />;
    case 'settings': return <SettingsPage />;
    default: return <NotFoundPage />;
  }
}

function Console() {
  const { pathname } = useRouter();
  const item = resolvePath(pathname);
  useEffect(() => {
    document.title = item ? `${item.label} · ClawRouter` : 'Not found · ClawRouter';
  }, [item]);
  return (
    <RealtimeProvider>
    <HealthProvider>
      <NotificationsProvider>
        <ConsoleLayout activeId={item?.id}>
          <ErrorBoundary resetKey={pathname} labels={PAGE_ERROR_LABELS} onError={(error, info) => console.error('Console page crashed', error, info.componentStack)}>
            <Suspense fallback={<BusyIndicator active text="Loading…" style={{ minHeight: '12rem' }} />}>
              <PageFor item={item} />
            </Suspense>
          </ErrorBoundary>
        </ConsoleLayout>
      </NotificationsProvider>
    </HealthProvider>
    </RealtimeProvider>
  );
}

/**
 * Chooses the screen from the auth state. This only decides what to render:
 * every API call is authorized by the server regardless (spec §16).
 */
function Gate() {
  const { state, retry } = useAuth();
  const { pathname, search, navigate } = useRouter();
  const target = redirectFor(state, pathname, search);

  useEffect(() => {
    if (target) navigate(target, { replace: true });
  }, [target, navigate]);
  useEffect(() => {
    if (state.status === 'setup-required') document.title = 'Setup · ClawRouter';
    if (state.status === 'signed-out') document.title = 'Sign in · ClawRouter';
  }, [state.status]);

  switch (state.status) {
    case 'loading':
      return <BusyIndicator active text="Loading ClawRouter…" style={{ height: '100%' }} />;
    case 'error':
      return (
        <EmptyState icon="disconnected" title="Cannot reach the ClawRouter server" description={state.message} actions={<Button onClick={retry}>Try again</Button>} />
      );
    case 'setup-required':
      return target ? null : <SetupPage />;
    case 'signed-out':
      return target ? null : <LoginPage />;
    case 'signed-in':
      if (target) return null;
      if (state.session.user.mustChangePassword) return <ForcedPasswordChange />;
      if (state.session.twoFactorSetupRequired) return <ForcedTwoFactorSetup />;
      // First-run setup wizard (owner request): until it is finished or dismissed, for those who can change settings.
      if (state.session.onboarding.setupWizard?.status === 'PENDING') {
        return <Suspense fallback={<BusyIndicator active text="Loading…" style={{ height: '100%' }} />}><SetupWizard /></Suspense>;
      }
      return <Console />;
  }
}

/**
 * Spec §18: dark graphite by default, dense; each user may choose Light, Dark or
 * System (owner request), so the theme sits inside the auth state that carries it.
 * Spec §20: touch screens get the cozy density (ThemeChoiceProvider).
 */
export function App() {
  return (
    <RouterProvider>
      <AuthProvider>
        <ThemeChoiceProvider>
          <ToastProvider>
            <Gate />
          </ToastProvider>
        </ThemeChoiceProvider>
      </AuthProvider>
    </RouterProvider>
  );
}
