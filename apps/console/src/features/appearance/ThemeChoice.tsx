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

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ThemeProvider, useMediaQuery } from '@enterprise-ui/react';
import type { ThemeChoice } from '@clawrouter/shared';
import { lastTheme, rememberTheme, saveTheme } from '../../services/preferences.ts';
import { useAuth } from '../auth/AuthContext.tsx';

interface ThemeChoiceValue {
  theme: ThemeChoice;
  /** What is showing: the choice, with System resolved to the device's setting. */
  shown: 'light' | 'dark';
  /** Applies at once; saved on the account when signed in, and in this browser. */
  setTheme(theme: ThemeChoice): Promise<void>;
}

const ThemeChoiceContext = createContext<ThemeChoiceValue | null>(null);

/**
 * The console's colour theme (owner request, 2026-11-17): Light, Dark or System,
 * remembered on the user's account. Before sign-in (setup, sign-in pages) the last
 * choice made in this browser applies. Spec §20: touch screens get the cozy density.
 */
export function ThemeChoiceProvider({ children }: { children: ReactNode }) {
  const { state, refresh } = useAuth();
  const touch = useMediaQuery('(pointer: coarse)');
  const deviceDark = useMediaQuery('(prefers-color-scheme: dark)');
  const accountTheme = state.status === 'signed-in' ? state.session.theme : null;
  // A choice just made, shown before the server confirms it.
  const [pending, setPending] = useState<ThemeChoice | null>(null);
  const theme = pending ?? accountTheme ?? lastTheme();

  // Signing in (on any device) brings the account's choice to this browser too.
  useEffect(() => {
    if (accountTheme) rememberTheme(accountTheme);
    setPending(null);
  }, [accountTheme]);

  const setTheme = useCallback(async (next: ThemeChoice) => {
    setPending(next);
    rememberTheme(next);
    if (state.status !== 'signed-in') return;
    try {
      await saveTheme(next);
      await refresh();
    } catch (error) {
      setPending(null); // back to what the account has
      throw error;
    }
  }, [state.status, refresh]);

  const shown = theme === 'system' ? (deviceDark ? 'dark' : 'light') : theme;
  const value = useMemo(() => ({ theme, shown, setTheme }), [theme, shown, setTheme]);
  return (
    <ThemeChoiceContext.Provider value={value}>
      <ThemeProvider theme={theme} density={touch ? 'cozy' : 'compact'} style={{ height: '100%' }}>
        {children}
      </ThemeProvider>
    </ThemeChoiceContext.Provider>
  );
}

export function useThemeChoice(): ThemeChoiceValue {
  const value = useContext(ThemeChoiceContext);
  if (!value) throw new Error('useThemeChoice must be used inside <ThemeChoiceProvider>');
  return value;
}
