import { Button, Dialog, Text, useToast } from '@enterprise-ui/react';
import { ChangePasswordForm } from './ChangePasswordForm.tsx';

/** User menu → Change password. Other sessions of this user end; this one stays signed in. */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  return (
    <Dialog open={open} onClose={onClose} title="Change password">
      {open && (
        <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
          <Text as="p" size="sm" tone="secondary">You stay signed in here; your other sessions are signed out.</Text>
          <ChangePasswordForm
            onChanged={() => {
              onClose();
              toast.show({ tone: 'success', title: 'Password changed', description: 'Your other sessions were signed out.' });
            }}
            extraActions={<Button variant="tertiary" onClick={onClose}>Cancel</Button>}
          />
        </div>
      )}
    </Dialog>
  );
}
