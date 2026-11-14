import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { BusyIndicator, Button, EmptyState, ThemeProvider, ToastProvider, useMediaQuery } from '@enterprise-ui/react';
import { HealthProvider } from '../features/health/HealthContext.tsx';
import { RealtimeProvider } from '../features/realtime/RealtimeContext.tsx';
import { NoAccessPage } from '../pages/NoAccessPage.tsx';
import { AuthProvider, useAuth, usePermissions } from '../features/auth/AuthContext.tsx';
import { redirectFor } from '../features/auth/auth-state.ts';
import { LoginPage } from '../features/auth/LoginPage.tsx';
import { SetupPage } from '../features/auth/SetupPage.tsx';
import { ForcedPasswordChange } from '../features/auth/ForcedPasswordChange.tsx';
import { ForcedTwoFactorSetup } from '../features/auth/ForcedTwoFactorSetup.tsx';
import { PlannedFeature } from '../components/custom/PlannedFeature.tsx';
import { PageErrorBoundary } from '../components/custom/PageErrorBoundary.tsx';
import { NotificationsProvider } from '../features/notifications/NotificationsContext.tsx';
import { ConsoleLayout } from '../layouts/ConsoleLayout.tsx';
import { NotFoundPage } from '../pages/NotFoundPage.tsx';
import { canSee, resolvePath, type NavItem } from './navigation.ts';
import { RouterProvider, useRouter } from './router.tsx';

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
const RateLimitsPage = page(() => import('../features/rate-limits/RateLimitsPage.tsx'), 'RateLimitsPage');
const RequestsPage = page(() => import('../features/requests/RequestsPage.tsx'), 'RequestsPage');
const UsagePage = page(() => import('../features/usage/UsagePage.tsx'), 'UsagePage');
const OperationsPage = page(() => import('../features/operations/OperationsPage.tsx'), 'OperationsPage');
const LogsPage = page(() => import('../features/logs/LogsPage.tsx'), 'LogsPage');
const AuditPage = page(() => import('../features/audit/AuditPage.tsx'), 'AuditPage');
const SettingsPage = page(() => import('../features/settings/SettingsPage.tsx'), 'SettingsPage');

function PageFor({ item }: { item: NavItem | undefined }) {
  const { set } = usePermissions();
  if (!item) return <NotFoundPage />;
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
    case 'rate-limits': return <RateLimitsPage />;
    case 'requests': return <RequestsPage />;
    case 'usage': return <UsagePage />;
    case 'operations': return <OperationsPage />;
    case 'logs': return <LogsPage />;
    case 'audit': return <AuditPage />;
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
          <PageErrorBoundary resetKey={pathname}>
            <Suspense fallback={<BusyIndicator active text="Loading…" style={{ minHeight: '12rem' }} />}>
              <PageFor item={item} />
            </Suspense>
          </PageErrorBoundary>
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
      return state.session.twoFactorSetupRequired ? <ForcedTwoFactorSetup /> : <Console />;
  }
}

/**
 * Spec §18: dark graphite, dense. Spec §20: touch targets of about 44px, so
 * touch screens get the cozy density while mouse users keep compact.
 */
export function App() {
  const touch = useMediaQuery('(pointer: coarse)');
  return (
    <ThemeProvider theme="dark" density={touch ? 'cozy' : 'compact'} style={{ height: '100%' }}>
      <ToastProvider>
        <RouterProvider>
          <AuthProvider>
            <Gate />
          </AuthProvider>
        </RouterProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
