import { useState, type ReactNode } from 'react';
import { AppShell, ApplicationHeader, Icon, NavigationGroup, NavigationItem, SideNavigation } from '@enterprise-ui/react';
import { NAVIGATION, itemById, type NavItem } from '../app/navigation.ts';
import { useRouter } from '../app/router.tsx';
import { HealthStateIndicator } from '../components/custom/HealthStateIndicator.tsx';
import { useAuth, useSession } from '../features/auth/AuthContext.tsx';
import { useHealth } from '../features/health/HealthContext.tsx';
import { MySessionsDialog } from '../features/sessions/MySessionsDialog.tsx';

function NavLink({ item }: { item: NavItem }) {
  return <NavigationItem id={item.id} label={item.label} icon={<Icon name={item.icon} />} href={item.path} />;
}

export function ConsoleLayout({ activeId, children }: { activeId: string | undefined; children: ReactNode }) {
  const { navigate } = useRouter();
  const { signOut } = useAuth();
  const { user } = useSession();
  const { data, error } = useHealth();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const gatewayState = error ? 'OFFLINE' : (data?.status ?? 'UNKNOWN');

  return (
    <AppShell
      header={
        <ApplicationHeader
          productName="ClawAPI"
          secondaryTitle="AI Gateway Control Plane"
          logo={<Icon name="it-host" color="var(--eui-color-primary)" />}
          homeHref="/"
          context={[{ id: 'gateway', content: <HealthStateIndicator state={gatewayState} label="System" size="sm" />, priority: 1 }]}
          // Roles arrive with RBAC (phase 3).
          user={{ name: user.displayName, email: user.username }}
          userMenuItems={[
            { id: 'sessions', label: 'My sessions', icon: 'user-settings' },
            { type: 'separator' },
            { id: 'logout', label: 'Sign out', icon: 'log' },
          ]}
          onUserAction={(id) => {
            if (id === 'sessions') setSessionsOpen(true);
            if (id === 'logout') void signOut();
          }}
        />
      }
      navigation={
        <SideNavigation
          aria-label="Console"
          activeId={activeId}
          onNavigate={(id, event) => {
            const item = itemById(id);
            if (!item) return;
            event.preventDefault();
            navigate(item.path);
          }}
        >
          {NAVIGATION.map((group) =>
            group.label === null ? (
              group.items.map((item) => <NavLink key={item.id} item={item} />)
            ) : (
              <NavigationGroup key={group.id} label={group.label}>
                {group.items.map((item) => <NavLink key={item.id} item={item} />)}
              </NavigationGroup>
            ),
          )}
        </SideNavigation>
      }
    >
      {children}
      <MySessionsDialog open={sessionsOpen} onClose={() => setSessionsOpen(false)} />
    </AppShell>
  );
}
