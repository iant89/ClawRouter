import { Tag, Text } from '@enterprise-ui/react';

const SCHEME: Record<string, 1 | 6 | 8> = { ADMIN: 1, OPERATOR: 6, VIEWER: 8 };

/** Role ids as tags; text always carries the meaning (never color alone). */
export function RoleTags({ roles, names }: { roles: string[]; names?: Map<string, string> }) {
  if (roles.length === 0) return <Text tone="secondary">No role</Text>;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 'var(--eui-space-1, 0.25rem)' }}>
      {roles.map((r) => (
        <Tag key={r} colorScheme={SCHEME[r] ?? 8}>{names?.get(r) ?? r}</Tag>
      ))}
    </span>
  );
}
