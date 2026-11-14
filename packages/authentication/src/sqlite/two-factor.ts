import type { Database } from '@clawrouter/database';

export interface TwoFactorRecord {
  totpCiphertext: string | null;
  totpConfirmedAt: string | null;
  totpLastStep: number | null;
  emailEnabledAt: string | null;
}

export type ChallengePurpose = 'SIGN_IN' | 'ENROLL_EMAIL';

export interface ChallengeRecord {
  id: string;
  tokenHash: string;
  userId: string;
  purpose: ChallengePurpose;
  codeHash: string | null;
  codeSentAt: string | null;
  sends: number;
  attempts: number;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

/** Storage for two-factor enrollment, recovery codes and sign-in challenges. */
export function createSqliteTwoFactorRepository(db: Database) {
  const upsert = (userId: string, at: string) =>
    db.run('INSERT INTO user_two_factor (user_id, updated_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING', [userId, at]);

  return {
    get(userId: string): TwoFactorRecord | undefined {
      const r = db.get<{ totp_ciphertext: string | null; totp_confirmed_at: string | null; totp_last_step: number | null; email_enabled_at: string | null }>(
        'SELECT totp_ciphertext, totp_confirmed_at, totp_last_step, email_enabled_at FROM user_two_factor WHERE user_id = ?', [userId],
      );
      return r ? { totpCiphertext: r.totp_ciphertext, totpConfirmedAt: r.totp_confirmed_at, totpLastStep: r.totp_last_step, emailEnabledAt: r.email_enabled_at } : undefined;
    },
    /** A new, unconfirmed authenticator secret (replaces any earlier one). */
    setTotpPending(userId: string, ciphertext: string, fingerprint: string, at: string) {
      upsert(userId, at);
      db.run('UPDATE user_two_factor SET totp_ciphertext = ?, totp_key_fingerprint = ?, totp_confirmed_at = NULL, totp_last_step = NULL, updated_at = ? WHERE user_id = ?', [ciphertext, fingerprint, at, userId]);
    },
    confirmTotp(userId: string, step: number, at: string) {
      db.run('UPDATE user_two_factor SET totp_confirmed_at = ?, totp_last_step = ?, updated_at = ? WHERE user_id = ?', [at, step, at, userId]);
    },
    /** Records the step a code was used for; false if that step (or a later one) was already used (a replay or a race). */
    useTotpStep(userId: string, step: number): boolean {
      return db.run('UPDATE user_two_factor SET totp_last_step = ? WHERE user_id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [step, userId, step]).changes === 1;
    },
    /** Every stored authenticator secret, with its owner's username (key rotation and checks). */
    listTotpSecrets(): { userId: string; username: string; ciphertext: string; fingerprint: string | null }[] {
      return db.all<{ user_id: string; username: string; totp_ciphertext: string; totp_key_fingerprint: string | null }>(
        'SELECT t.user_id, u.username, t.totp_ciphertext, t.totp_key_fingerprint FROM user_two_factor t JOIN users u ON u.id = t.user_id WHERE t.totp_ciphertext IS NOT NULL ORDER BY u.username',
      ).map((r) => ({ userId: r.user_id, username: r.username, ciphertext: r.totp_ciphertext, fingerprint: r.totp_key_fingerprint }));
    },
    /** Swaps a re-encrypted secret in; false if it changed meanwhile. */
    replaceTotpSecret(userId: string, from: string, ciphertext: string, fingerprint: string): boolean {
      return db.run('UPDATE user_two_factor SET totp_ciphertext = ?, totp_key_fingerprint = ? WHERE user_id = ? AND totp_ciphertext = ?', [ciphertext, fingerprint, userId, from]).changes === 1;
    },
    clearTotp(userId: string, at: string) {
      db.run('UPDATE user_two_factor SET totp_ciphertext = NULL, totp_key_fingerprint = NULL, totp_confirmed_at = NULL, totp_last_step = NULL, updated_at = ? WHERE user_id = ?', [at, userId]);
    },
    setEmailEnabled(userId: string, enabledAt: string | null, at: string) {
      upsert(userId, at);
      db.run('UPDATE user_two_factor SET email_enabled_at = ?, updated_at = ? WHERE user_id = ?', [enabledAt, at, userId]);
    },
    /** Removes every method and recovery code (administrator reset, recovery). */
    deleteAll(userId: string) {
      db.transaction((tx) => {
        tx.run('DELETE FROM user_two_factor WHERE user_id = ?', [userId]);
        tx.run('DELETE FROM recovery_codes WHERE user_id = ?', [userId]);
        tx.run("UPDATE sign_in_challenges SET used_at = COALESCE(used_at, created_at) WHERE user_id = ?", [userId]);
      });
    },

    replaceRecoveryCodes(userId: string, hashes: string[], at: string) {
      db.transaction((tx) => {
        tx.run('DELETE FROM recovery_codes WHERE user_id = ?', [userId]);
        for (const h of hashes) tx.run('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)', [userId, h, at]);
      });
    },
    /** Marks a recovery code used; false if unknown or already used. */
    useRecoveryCode(userId: string, hash: string, at: string): boolean {
      return db.run('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', [at, userId, hash]).changes === 1;
    },
    recoveryCodesLeft: (userId: string) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [userId])?.n ?? 0,

    insertChallenge(c: { id: string; tokenHash: string; userId: string; purpose: ChallengePurpose; ip: string | null; userAgent: string | null; at: string; expiresAt: string }) {
      db.run(
        'INSERT INTO sign_in_challenges (id, token_hash, user_id, purpose, ip, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [c.id, c.tokenHash, c.userId, c.purpose, c.ip, c.userAgent, c.at, c.expiresAt],
      );
    },
    findChallenge(tokenHash: string): ChallengeRecord | undefined {
      const r = db.get<{ id: string; token_hash: string; user_id: string; purpose: ChallengePurpose; code_hash: string | null; code_sent_at: string | null; attempts: number; created_at: string; expires_at: string; used_at: string | null }>(
        'SELECT * FROM sign_in_challenges WHERE token_hash = ?', [tokenHash],
      );
      if (!r) return undefined;
      return {
        id: r.id, tokenHash: r.token_hash, userId: r.user_id, purpose: r.purpose, codeHash: r.code_hash, codeSentAt: r.code_sent_at,
        sends: 0, attempts: r.attempts, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at,
      };
    },
    /** The latest unused email-enrollment challenge of a user. */
    latestEnrollment(userId: string): ChallengeRecord | undefined {
      const r = db.get<{ token_hash: string }>("SELECT token_hash FROM sign_in_challenges WHERE user_id = ? AND purpose = 'ENROLL_EMAIL' AND used_at IS NULL ORDER BY created_at DESC LIMIT 1", [userId]);
      return r ? this.findChallenge(r.token_hash) : undefined;
    },
    setCode(id: string, codeHash: string, at: string) {
      db.run('UPDATE sign_in_challenges SET code_hash = ?, code_sent_at = ? WHERE id = ?', [codeHash, at, id]);
    },
    addAttempt: (id: string) => db.run('UPDATE sign_in_challenges SET attempts = attempts + 1 WHERE id = ?', [id]),
    /** Uses a challenge once; false if it was already used (e.g. a second request racing the first). */
    markUsed: (id: string, at: string) => db.run('UPDATE sign_in_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL', [at, id]).changes === 1,
    purge: (before: string) => db.run('DELETE FROM sign_in_challenges WHERE expires_at < ?', [before]).changes,
  };
}

export type TwoFactorRepository = ReturnType<typeof createSqliteTwoFactorRepository>;
