import { Button, EmptyState, Page } from '@enterprise-ui/react';
import { useRouter } from '../app/router.tsx';

export function NotFoundPage() {
  const { navigate } = useRouter();
  return (
    <Page title="Page not found">
      <EmptyState
        icon="search"
        title="This page does not exist"
        description="Check the address, or go back to the dashboard."
        actions={<Button onClick={() => navigate('/')}>Go to dashboard</Button>}
      />
    </Page>
  );
}
