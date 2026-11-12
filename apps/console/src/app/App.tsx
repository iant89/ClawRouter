import { useEffect } from 'react';
import { BusyIndicator, Button, EmptyState, ThemeProvider, ToastProvider } from '@enterprise-ui/react';
import { DashboardPage } from '../features/dashboard/DashboardPage.tsx';
import { HealthPage } from '../features/health/HealthPage.tsx';
import { HealthProvider } from '../features/health/HealthContext.tsx';
import { AuthProvider, useAuth } from '../features/auth/AuthContext.tsx';
import { redirectFor } from '../features/auth/auth-state.ts';
import { LoginPage } from '../features/auth/LoginPage.tsx';
import { SetupPage } from '../features/auth/SetupPage.tsx';
import { PlannedFeature } from '../components/custom/PlannedFeature.tsx';
import { ConsoleLayout } from '../layouts/ConsoleLayout.tsx';
import { NotFoundPage } from '../pages/NotFoundPage.tsx';
import { resolvePath, type NavItem } from './navigation.ts';
import { RouterProvider, useRouter } from './router.tsx';

function PageFor({ item }: { item: NavItem | undefined }) {
  if (!item) return <NotFoundPage />;
  if (item.plannedPhase !== undefined) return <PlannedFeature item={item} />;
  switch (item.id) {
    case 'dashboard': return <DashboardPage />;
    case 'health': return <HealthPage />;
    default: return <NotFoundPage />;
  }
}

function Console() {
  const { pathname } = useRouter();
  const item = resolvePath(pathname);
  useEffect(() => {
    document.title = item ? `${item.label} · ClawAPI` : 'Not found · ClawAPI';
  }, [item]);
  return (
    <HealthProvider>
      <ConsoleLayout activeId={item?.id}>
        <PageFor item={item} />
      </ConsoleLayout>
    </HealthProvider>
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
    if (state.status === 'setup-required') document.title = 'Setup · ClawAPI';
    if (state.status === 'signed-out') document.title = 'Sign in · ClawAPI';
  }, [state.status]);

  switch (state.status) {
    case 'loading':
      return <BusyIndicator active text="Loading ClawAPI…" style={{ height: '100%' }} />;
    case 'error':
      return (
        <EmptyState icon="disconnected" title="Cannot reach the ClawAPI server" description={state.message} actions={<Button onClick={retry}>Try again</Button>} />
      );
    case 'setup-required':
      return target ? null : <SetupPage />;
    case 'signed-out':
      return target ? null : <LoginPage />;
    case 'signed-in':
      return target ? null : <Console />;
  }
}

/** Spec §18: dark graphite, dense. */
export function App() {
  return (
    <ThemeProvider theme="dark" density="compact" style={{ height: '100%' }}>
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
