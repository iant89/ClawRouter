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

import { useEffect, useState } from 'react';
import { fetchModels } from '../../services/models.ts';
import { fetchRouting } from '../../services/routing.ts';
import { usePermissions } from '../auth/AuthContext.tsx';

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * Aliases and models a key can be limited to, loaded the first time `enabled`
 * is true. Optional: without routing.read / models.read the list is empty and
 * the field stays free to leave empty ("any model").
 */
export function useModelOptions(enabled: boolean): ModelOption[] {
  const perms = usePermissions();
  const canRouting = perms.can('routing.read');
  const canModels = perms.can('models.read');
  const [options, setOptions] = useState<ModelOption[]>([]);

  useEffect(() => {
    if (!enabled || options.length) return;
    const controller = new AbortController();
    const aliases = canRouting
      ? fetchRouting(controller.signal).then((r) => r.aliases.map((a) => ({ value: a.name, label: a.name, description: `Alias${a.description ? ` · ${a.description}` : ''}` }))).catch(() => [])
      : Promise.resolve([]);
    const models = canModels
      ? fetchModels({ page: 1, pageSize: 200 }, controller.signal).then((r) => r.items.map((m) => ({ value: m.ref, label: m.ref, description: m.displayName }))).catch(() => [])
      : Promise.resolve([]);
    void Promise.all([aliases, models]).then(([a, m]) => { if (!controller.signal.aborted) setOptions([...a, ...m]); });
    return () => controller.abort();
  }, [enabled, options.length, canRouting, canModels]);

  return options;
}
