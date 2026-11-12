import { PASSWORD_POLICY, type FieldIssue } from '@clawapi/shared';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface Argon2Options {
  /** KiB. Bun's default (64 MiB) unless overridden; tests use less. */
  memoryCost?: number;
  timeCost?: number;
}

/** argon2id via Bun's built-in implementation (no native dependency). */
export function createArgon2Hasher(options: Argon2Options = {}): PasswordHasher {
  const params = { algorithm: 'argon2id' as const, ...options };
  return {
    hash: (password) => Bun.password.hash(password, params),
    verify: async (password, hash) => {
      try {
        return await Bun.password.verify(password, hash);
      } catch {
        return false; // malformed hash: treat as mismatch, never crash a login
      }
    },
  };
}

/** Returns policy violations for a new password (empty when acceptable). */
export function checkPasswordPolicy(password: string, username: string, path = 'password'): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (password.length < PASSWORD_POLICY.minLength) issues.push({ path, message: `must be at least ${PASSWORD_POLICY.minLength} characters` });
  if (password.length > PASSWORD_POLICY.maxLength) issues.push({ path, message: `must be at most ${PASSWORD_POLICY.maxLength} characters` });
  if (username && password.toLowerCase().includes(username.toLowerCase())) issues.push({ path, message: 'must not contain the username' });
  if (password.length > 0 && new Set(password).size < 4) issues.push({ path, message: 'must use at least 4 different characters' });
  return issues;
}
