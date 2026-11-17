import { errors, type Logger } from '@clawrouter/core';
import type { Database } from '@clawrouter/database';
import { DEFAULT_THEME, THEME_CHOICES, type ThemeChoice } from '@clawrouter/shared';

export type PreferencesService = ReturnType<typeof createPreferencesService>;

/**
 * A user's own console preferences (owner request, 2026-11-17: theme selection,
 * remembered on the account so it follows them to every device). A preference is
 * not worth an audit record; it is logged.
 */
export function createPreferencesService(options: { db: Database; log?: Logger }) {
  const { db, log } = options;
  return {
    theme(userId: string): ThemeChoice {
      const stored = db.get<{ theme: ThemeChoice | null }>('SELECT theme FROM users WHERE id = ?', [userId])?.theme;
      return stored ?? DEFAULT_THEME;
    },

    setTheme(userId: string, theme: unknown): ThemeChoice {
      if (!(THEME_CHOICES as readonly unknown[]).includes(theme)) throw errors.validation([{ path: 'theme', message: `must be one of ${THEME_CHOICES.join(', ')}` }]);
      db.run('UPDATE users SET theme = ? WHERE id = ?', [theme as ThemeChoice, userId]);
      log?.info('theme changed', { component: 'preferences', userId, theme });
      return theme as ThemeChoice;
    },
  };
}
