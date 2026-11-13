import { Button, PasswordInput } from '@enterprise-ui/react';
import { PASSWORD_POLICY } from '@clawrouter/shared';

/** A readable random password (about 100 bits): five groups of five, no look-alike characters. */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return ([...bytes].map((b) => alphabet[b % alphabet.length]).join('').match(/.{5}/g) ?? []).join('-');
}

/**
 * A temporary password chosen by an administrator. The user must replace it at
 * their next sign-in. Pass it on through a trusted channel; ClawRouter never shows it again.
 */
export function TemporaryPasswordField({ value, onChange, error }: { value: string; onChange: (value: string) => void; error?: string }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--eui-space-1, 0.25rem)' }}>
      <PasswordInput
        id="temp-password" label="Temporary password" purpose="new" autoComplete="new-password" required value={value}
        onChange={(e) => onChange(e.target.value)} error={error}
        description="The user must choose their own password when they sign in with it. Pass it on in person or through a trusted channel."
        requirements={[{ label: `At least ${PASSWORD_POLICY.minLength} characters`, test: (p) => p.length >= PASSWORD_POLICY.minLength }]}
      />
      <div>
        <Button size="sm" variant="secondary" icon="refresh" onClick={() => onChange(generatePassword())}>Generate</Button>
      </div>
    </div>
  );
}
