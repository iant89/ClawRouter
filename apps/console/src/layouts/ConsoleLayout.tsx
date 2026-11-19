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

import { useState, type ReactNode } from 'react';
import { AppShell, ApplicationHeader, Icon, NavigationGroup, NavigationItem, SideNavigation, useToast } from '@enterprise-ui/react';
import { itemById, visibleNavigation, type NavItem } from '../app/navigation.ts';
import { useRouter } from '../app/router.tsx';
import { HealthStateIndicator } from '../components/custom/HealthStateIndicator.tsx';
import { LiveIndicator } from '../components/custom/LiveIndicator.tsx';
import { useAuth, usePermissions, useSession } from '../features/auth/AuthContext.tsx';
import { useHealth } from '../features/health/HealthContext.tsx';
import { MySessionsDialog } from '../features/sessions/MySessionsDialog.tsx';
import { ChangePasswordDialog } from '../features/auth/ChangePasswordDialog.tsx';
import { AccountSecurityDialog } from '../features/auth/AccountSecurityDialog.tsx';
import { NotificationsPanel } from '../features/notifications/NotificationsPanel.tsx';
import { ConsoleTour } from '../features/onboarding/ConsoleTour.tsx';
import { AppearanceDialog } from '../features/appearance/AppearanceDialog.tsx';
import { useThemeChoice } from '../features/appearance/ThemeChoice.tsx';
import { updateSetupWizard } from '../services/onboarding.ts';
import { useNotifications } from '../features/notifications/NotificationsContext.tsx';

function NavLink({ item }: { item: NavItem }) {
  return <NavigationItem id={item.id} label={item.label} icon={<Icon name={item.icon} />} href={item.path} />;
}

const ROLE_LABELS: Record<string, string> = { ADMIN: 'Administrator', OPERATOR: 'Operator', VIEWER: 'Viewer' };
const roleLabel = (id: string) => ROLE_LABELS[id] ?? id;

export function ConsoleLayout({ activeId, children }: { activeId: string | undefined; children: ReactNode }) {
  const { navigate } = useRouter();
  const { signOut, refresh } = useAuth();
  const { user, roles, onboarding } = useSession();
  // A new user's tour opens by itself once; afterwards only from the help menu.
  const [tourOpen, setTourOpen] = useState(onboarding.tour === 'PENDING');
  const { set: permissions } = usePermissions();
  const { data, error } = useHealth();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  // Header toggle (owner request): flips what is showing; System stays available under Appearance.
  const { shown, setTheme } = useThemeChoice();
  const toast = useToast();
  const toggleTheme = () => void setTheme(shown === 'dark' ? 'light' : 'dark').catch((err: unknown) => toast.show({ tone: 'error', title: 'Could not save the theme', description: err instanceof Error ? err.message : undefined, duration: 10_000 }));
  const { unread } = useNotifications();
  const gatewayState = error ? 'OFFLINE' : (data?.status ?? 'UNKNOWN');

  return (
    <AppShell
      header={
        <ApplicationHeader
          productName="ClawRouter"
          secondaryTitle="AI Gateway Control Plane"
          logo={<Icon name="it-host" color="var(--eui-color-primary)" />}
          homeHref="/"
          context={[
            { id: 'gateway', content: <span data-tour="health"><HealthStateIndicator state={gatewayState} label="System" size="sm" /></span>, priority: 1 },
            { id: 'live', content: <LiveIndicator />, priority: 2 },
          ]}
          helpItems={[
            { id: 'tour', label: 'Take the guided tour', icon: 'map' },
            ...(onboarding.setupWizard ? [{ id: 'setup', label: 'Run the setup wizard', icon: 'action-settings' as const }] : []),
          ]}
          onHelpAction={(id) => {
            if (id === 'tour') setTourOpen(true);
            // Back to the start of the wizard; the console shows it when the session says it is pending.
            if (id === 'setup') void updateSetupWizard({ status: 'PENDING', step: null }).then(() => refresh());
          }}
          notificationCount={unread}
          notifications={<NotificationsPanel />}
          additionalActions={[{ id: 'theme', label: shown === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', icon: shown === 'dark' ? 'light-mode' : 'dark-mode', onClick: toggleTheme }]}
          user={{ name: user.displayName, email: user.username, role: roles.length ? roles.map(roleLabel).join(', ') : 'No role' }}
          userMenuItems={[
            { id: 'sessions', label: 'My sessions', icon: 'user-settings' },
            { id: 'password', label: 'Change password', icon: 'key' },
            { id: 'security', label: 'Sign-in security', icon: 'locked' },
            { id: 'appearance', label: 'Appearance', icon: 'palette' },
            { type: 'separator' },
            { id: 'logout', label: 'Sign out', icon: 'log' },
          ]}
          onUserAction={(id) => {
            if (id === 'sessions') setSessionsOpen(true);
            if (id === 'password') setPasswordOpen(true);
            if (id === 'security') setSecurityOpen(true);
            if (id === 'appearance') setAppearanceOpen(true);
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
          {visibleNavigation(permissions).map((group) =>
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
      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      <AccountSecurityDialog open={securityOpen} onClose={() => setSecurityOpen(false)} />
      <AppearanceDialog open={appearanceOpen} onClose={() => setAppearanceOpen(false)} />
      <ConsoleTour open={tourOpen} onClose={() => setTourOpen(false)} />
    </AppShell>
  );
}
