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

import { useState } from 'react';
import { Button, Dialog, MessageStrip, RadioGroup } from '@enterprise-ui/react';
import type { ThemeChoice } from '@clawrouter/shared';
import { useThemeChoice } from './ThemeChoice.tsx';

const OPTIONS: { value: ThemeChoice; label: string; description: string }[] = [
  { value: 'dark', label: 'Dark', description: 'The default: dark graphite, easy on the eyes for long sessions.' },
  { value: 'light', label: 'Light', description: 'Dark text on a light background.' },
  { value: 'system', label: 'System', description: 'Follows your device: light or dark as its setting changes.' },
];

/** User menu → Appearance: the theme applies as soon as it is picked and follows the user to other devices. */
export function AppearanceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { theme, setTheme } = useThemeChoice();
  const [error, setError] = useState<string | null>(null);

  const pick = (next: ThemeChoice) => {
    setError(null);
    void setTheme(next).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not save the theme.'));
  };

  return (
    <Dialog open={open} onClose={onClose} title="Appearance" size="sm" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      {error && <MessageStrip tone="error" announce="assertive">{error}</MessageStrip>}
      <RadioGroup<ThemeChoice>
        label="Theme"
        description="Saved on your account, so it follows you to every browser and device."
        value={theme}
        onChange={pick}
        options={OPTIONS}
      />
    </Dialog>
  );
}
