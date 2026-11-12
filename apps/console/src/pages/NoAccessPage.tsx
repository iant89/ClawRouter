import { Button, EmptyState, Page } from '@enterprise-ui/react';
import type { NavItem } from '../app/navigation.ts';
import { useRouter } from '../app/router.tsx';

/** Shown when a page is opened directly without its permission. Not a security boundary: the API refuses too. */
export function NoAccessPage({ item }: { item: NavItem }) {
  const { navigate } = useRouter();
  return (
    <Page title={item.label}>
      <EmptyState
        icon="locked"
        title="You do not have access to this page"
        description={`It requires the "${item.permission}" permission. Ask an administrator to assign you a role that includes it.`}
        actions={<Button onClick={() => navigate('/')}>Go to dashboard</Button>}
      />
    </Page>
  );
}
