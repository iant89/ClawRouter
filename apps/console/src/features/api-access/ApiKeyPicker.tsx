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

import { useEffect, useRef, useState } from 'react';
import { ComboBox } from '@enterprise-ui/react';
import type { ApiKeyInfo } from '@clawrouter/shared';
import { fetchApiKeys } from '../../services/gateway.ts';

const MATCHES = 20;

/**
 * Chooses one API key by typing part of its name, prefix or owner. The server
 * searches (phase 16: there can be thousands of keys, so they are never all sent
 * to the browser). `value` null means "any key".
 */
export function ApiKeyPicker({ value, onChange, label = 'API key' }: { value: string | null; onChange: (id: string | null) => void; label?: string }) {
  const [text, setText] = useState('');
  const [matches, setMatches] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(false);
  // The chosen key stays listed whatever is typed, so its name keeps showing.
  const chosen = useRef<ApiKeyInfo | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      fetchApiKeys({ q: text.trim(), pageSize: MATCHES }, controller.signal)
        .then((r) => setMatches(r.items))
        .catch(() => {})
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [text]);

  if (value === null) chosen.current = null;
  const list = chosen.current && !matches.some((k) => k.id === chosen.current!.id) ? [chosen.current, ...matches] : matches;

  return (
    <ComboBox
      label={label}
      placeholder="Any key"
      clearable
      value={value}
      loading={loading}
      emptyText={text.trim() ? 'No key matches.' : 'No API keys.'}
      // The server already filtered by the typed text.
      filter={() => true}
      onInputChange={setText}
      onChange={(id) => {
        chosen.current = list.find((k) => k.id === id) ?? null;
        onChange(id);
      }}
      options={list.map((k) => ({ value: k.id, label: k.name, description: `${k.prefix}…${k.createdBy ? ` · ${k.createdBy.username}` : ''}` }))}
    />
  );
}
