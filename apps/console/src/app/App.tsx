import { useEffect } from 'react';
import { ThemeProvider, ToastProvider } from '@enterprise-ui/react';
import { DashboardPage } from '../features/dashboard/DashboardPage.tsx';
import { HealthPage } from '../features/health/HealthPage.tsx';
import { HealthProvider } from '../features/health/HealthContext.tsx';
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
    <ConsoleLayout activeId={item?.id}>
      <PageFor item={item} />
    </ConsoleLayout>
  );
}

/** Spec §18: dark graphite, dense. */
export function App() {
  return (
    <ThemeProvider theme="dark" density="compact" style={{ height: '100%' }}>
      <ToastProvider>
        <RouterProvider>
          <HealthProvider>
            <Console />
          </HealthProvider>
        </RouterProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
