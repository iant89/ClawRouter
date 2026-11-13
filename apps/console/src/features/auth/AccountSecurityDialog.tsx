import { Button, Dialog } from '@enterprise-ui/react';
import { AccountSecurity } from './AccountSecurity.tsx';

/** User menu → Sign-in security: email address and two-factor sign-in. */
export function AccountSecurityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Sign-in security" size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {open && <AccountSecurity />}
    </Dialog>
  );
}
