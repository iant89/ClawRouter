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

import { Button, EmptyState } from '@enterprise-ui/react';

export function EmptyStateFor({ canWrite, onAdd }: { canWrite: boolean; onAdd: () => void }) {
  return (
    <EmptyState
      size="sm"
      icon="connected"
      title="No providers yet"
      description="Add OpenAI, Anthropic, Google or a local OpenAI-compatible server to start routing AI requests."
      actions={canWrite ? <Button variant="primary" onClick={onAdd}>Add provider</Button> : undefined}
    />
  );
}
