import type { Migration } from '../migrations.ts';
import { m0001Settings } from './0001_settings.ts';
import { m0002UsersSessions } from './0002_users_sessions.ts';
import { m0003AuditLog } from './0003_audit_log.ts';
import { m0004Roles } from './0004_roles.ts';
import { m0005Notifications } from './0005_notifications.ts';
import { m0006Providers } from './0006_providers.ts';

/** All migrations, in order. Append only. */
export const migrations: readonly Migration[] = [m0001Settings, m0002UsersSessions, m0003AuditLog, m0004Roles, m0005Notifications, m0006Providers];
