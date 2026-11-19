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

import type { ReactNode } from 'react';
import { Card, Icon, Text, Title } from '@enterprise-ui/react';

/**
 * Signed-out frame: product identity above a single card. A composition of
 * ENTERPRISE-UI Card/Icon/Text with layout-only inline styles that use tokens.
 */
export function AuthPanel({ title, subtitle, wide, children }: { title: string; subtitle?: ReactNode; /** true: 40rem; 'xl': 60rem (the setup wizard). */ wide?: boolean | 'xl'; children: ReactNode }) {
  return (
    <main
      id="main-content"
      style={{
        minHeight: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--eui-space-6, 1.5rem) var(--eui-space-4, 1rem)',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ width: '100%', maxWidth: wide === 'xl' ? '60rem' : wide ? '40rem' : '26rem', display: 'grid', gap: 'var(--eui-space-4, 1rem)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eui-space-2, 0.5rem)' }}>
          <Icon name="it-host" color="var(--eui-color-primary)" />
          <Title level={1} size="md">ClawRouter</Title>
          <Text tone="secondary">AI Gateway Control Plane</Text>
        </div>
        <Card title={title} subtitle={subtitle} headingLevel={2}>
          {children}
        </Card>
      </div>
    </main>
  );
}
