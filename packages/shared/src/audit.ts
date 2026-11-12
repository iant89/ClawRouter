/** Audit vocabulary (spec §28). */
export const AUDIT_ACTIONS = [
  'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'SETUP_COMPLETED',
  'PROVIDER_CREATED', 'PROVIDER_UPDATED', 'PROVIDER_ENABLED', 'PROVIDER_DISABLED',
  'CREDENTIAL_CREATED', 'CREDENTIAL_REPLACED', 'CREDENTIAL_REMOVED',
  'CONNECTION_TEST',
  'MODEL_CREATED', 'MODEL_UPDATED', 'MODEL_ENABLED', 'MODEL_DISABLED',
  'ROUTING_UPDATED',
  'API_KEY_CREATED', 'API_KEY_REVOKED',
  'USER_CREATED', 'USER_ENABLED', 'USER_DISABLED',
  'ROLE_CHANGED',
  'SETTINGS_CHANGED',
  'SESSION_REVOKED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditResult = 'SUCCESS' | 'FAILURE';

export interface AuditRecord {
  id: string;
  timestamp: string;
  actorId: string | null;
  actorName: string | null;
  action: AuditAction;
  resource: string | null;
  resourceId: string | null;
  result: AuditResult;
  ip: string | null;
  requestId: string | null;
  metadata: Record<string, unknown> | null;
}
