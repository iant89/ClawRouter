import { EmptyState, Page } from '@enterprise-ui/react';
import type { NavItem } from '../../app/navigation.ts';

/**
 * Placeholder for a console page whose domain has not been built yet. It says
 * plainly that nothing is there instead of showing invented data.
 */
export function PlannedFeature({ item }: { item: NavItem }) {
  return (
    <Page title={item.label} subtitle={item.summary}>
      <EmptyState
        icon={item.icon}
        title={`${item.label} is not available yet`}
        description={`This area is delivered in roadmap phase ${item.plannedPhase}. The server API for it does not exist yet, so there is nothing to show.`}
      />
    </Page>
  );
}
