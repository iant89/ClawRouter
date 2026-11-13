/** Audit vocabulary (spec §28). */
export const AUDIT_ACTIONS = [
  'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'SETUP_COMPLETED',
  'PROVIDER_CREATED', 'PROVIDER_UPDATED', 'PROVIDER_ENABLED', 'PROVIDER_DISABLED', 'PROVIDER_DELETED',
  'CREDENTIAL_CREATED', 'CREDENTIAL_REPLACED', 'CREDENTIAL_REMOVED',
  'CONNECTION_TEST',
  'MODEL_CREATED', 'MODEL_UPDATED', 'MODEL_ENABLED', 'MODEL_DISABLED', 'MODEL_DELETED',
  'ROUTING_UPDATED',
  'API_KEY_CREATED', 'API_KEY_REVOKED', 'API_KEY_UPDATED',
  'API_KEY_REQUESTED', 'API_KEY_REQUEST_APPROVED', 'API_KEY_REQUEST_DENIED', 'API_KEY_REQUEST_CANCELLED',
  'RATE_LIMITS_UPDATED',
  'OPERATION_STARTED', 'OPERATION_CANCELLED',
  'USER_CREATED', 'USER_UPDATED', 'USER_ENABLED', 'USER_DISABLED', 'PASSWORD_RESET', 'PASSWORD_CHANGED',
  'ROLE_CHANGED', 'ROLE_CREATED', 'ROLE_UPDATED', 'ROLE_DELETED',
  'SETTINGS_CHANGED', 'SECRET_KEY_ROTATED',
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

/** GET /api/audit filters (spec §28). */
export interface AuditSearch {
  page?: number;
  pageSize?: number;
  action?: AuditAction;
  result?: AuditResult;
  resource?: string;
  resourceId?: string;
  /** Text in the actor's name. */
  actor?: string;
  requestId?: string;
  /** ISO date-times, inclusive start and exclusive end. */
  from?: string;
  to?: string;
  /** Text anywhere: actor, resource id, IP, request id or metadata. */
  q?: string;
}
