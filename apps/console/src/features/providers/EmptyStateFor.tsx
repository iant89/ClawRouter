import { Button, EmptyState } from '@enterprise-ui/react';

export function EmptyStateFor({ canWrite, onAdd }: { canWrite: boolean; onAdd: () => void }) {
  return (
    <EmptyState
      size="sm"
      icon="connected"
      title="No providers yet"
      description="Add OpenAI, Anthropic, Google or a local OpenAI-compatible server to start routing AI requests."
      actions={canWrite ? <Button variant="primary" onClick={onAdd}>Add provider</Button> : undefined}
    />
  );
}
