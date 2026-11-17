import { DEFAULT_THEME, THEME_CHOICES, type ThemeChoice } from '@clawrouter/shared';
import { apiPut } from './api-client.ts';

/** Saves the signed-in user's console theme on their account. */
export const saveTheme = (theme: ThemeChoice) => apiPut<{ theme: ThemeChoice }>('/api/auth/theme', { theme });

const KEY = 'clawrouter.theme';

/**
 * The last theme chosen in this browser, for the screens before sign-in (setup,
 * sign-in). The account's choice wins once signed in. Storage can be unavailable
 * (private windows, blocked site data): then the default.
 */
export function lastTheme(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(KEY);
    return (THEME_CHOICES as readonly string[]).includes(stored ?? '') ? (stored as ThemeChoice) : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function rememberTheme(theme: ThemeChoice): void {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // Not remembered in this browser; the account still has it.
  }
}
