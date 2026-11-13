import { Button, Text } from '@enterprise-ui/react';
import { AuthPanel } from '../../components/custom/AuthPanel.tsx';
import { AccountSecurity } from './AccountSecurity.tsx';
import { useAuth } from './AuthContext.tsx';

/**
 * Shown instead of the console while an administrator requires two-factor
 * sign-in and the user has not set it up. The server refuses every other API
 * call (403 two_factor_setup_required) until a method is enabled.
 */
export function ForcedTwoFactorSetup() {
  const { state, signOut } = useAuth();
  const name = state.status === 'signed-in' ? state.session.user.displayName : '';
  return (
    <AuthPanel title="Set up two-factor sign-in" subtitle={`Welcome, ${name}`} wide>
      <div style={{ display: 'grid', gap: 'var(--eui-space-3, 0.75rem)' }}>
        <Text as="p">Your administrator requires a second step when you sign in. Set up a method below to continue.</Text>
        <AccountSecurity />
        <div><Button variant="tertiary" onClick={() => void signOut()}>Sign out</Button></div>
      </div>
    </AuthPanel>
  );
}
