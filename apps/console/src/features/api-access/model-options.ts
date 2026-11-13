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
