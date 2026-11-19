/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

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
