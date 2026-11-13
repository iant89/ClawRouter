import { Button, Text } from '@enterprise-ui/react';
import { AuthPanel } from '../../components/custom/AuthPanel.tsx';
import { useAuth } from './AuthContext.tsx';
import { ChangePasswordForm } from './ChangePasswordForm.tsx';

/**
 * Shown instead of the console while the user has a temporary password (a new
 * account or an administrator reset). The server refuses every other API call
 * until it is changed, so this is the only way forward.
 */
export function ForcedPasswordChange() {
  const { state, refresh, signOut } = useAuth();
  const name = state.status === 'signed-in' ? state.session.user.displayName : '';
  return (
    <AuthPanel title="Choose a new password" subtitle={`Welcome, ${name}`}>
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        <Text as="p">You signed in with a temporary password. Choose your own password to continue.</Text>
        <ChangePasswordForm
          currentLabel="Temporary password"
          submitLabel="Save and continue"
          onChanged={() => void refresh()}
          extraActions={<Button variant="tertiary" onClick={() => void signOut()}>Sign out</Button>}
        />
      </div>
    </AuthPanel>
  );
}
