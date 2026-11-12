import type { ReactNode } from 'react';
import { Card, Icon, Text, Title } from '@enterprise-ui/react';

/**
 * Signed-out frame: product identity above a single card. A composition of
 * ENTERPRISE-UI Card/Icon/Text with layout-only inline styles that use tokens.
 */
export function AuthPanel({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
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
      <div style={{ width: '100%', maxWidth: '26rem', display: 'grid', gap: 'var(--eui-space-4, 1rem)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eui-space-2, 0.5rem)' }}>
          <Icon name="it-host" color="var(--eui-color-primary)" />
          <Title level={1} size="md">ClawAPI</Title>
          <Text tone="secondary">AI Gateway Control Plane</Text>
        </div>
        <Card title={title} subtitle={subtitle} headingLevel={2}>
          {children}
        </Card>
      </div>
    </main>
  );
}
