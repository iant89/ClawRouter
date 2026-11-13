import type { Migration } from '../migrations.ts';
import { m0001Settings } from './0001_settings.ts';
import { m0002UsersSessions } from './0002_users_sessions.ts';
import { m0003AuditLog } from './0003_audit_log.ts';
import { m0004Roles } from './0004_roles.ts';
import { m0005Notifications } from './0005_notifications.ts';
import { m0006Providers } from './0006_providers.ts';
import { m0007Models } from './0007_models.ts';
import { m0008Routing } from './0008_routing.ts';
import { m0009ApiKeys } from './0009_api_keys.ts';
import { m0010RateLimits } from './0010_rate_limits.ts';
import { m0011Requests } from './0011_requests.ts';
import { m0012HealthOperations } from './0012_health_operations.ts';
import { m0013CustomRolesUsers } from './0013_custom_roles_users.ts';
import { m0014ApiKeyRequests } from './0014_api_key_requests.ts';
import { m0015KeyLifetimeLimits } from './0015_key_lifetime_limits.ts';
import { m0016TwoFactor } from './0016_two_factor.ts';

/** All migrations, in order. Append only. */
export const migrations: readonly Migration[] = [m0001Settings, m0002UsersSessions, m0003AuditLog, m0004Roles, m0005Notifications, m0006Providers, m0007Models, m0008Routing, m0009ApiKeys, m0010RateLimits, m0011Requests, m0012HealthOperations, m0013CustomRolesUsers, m0014ApiKeyRequests, m0015KeyLifetimeLimits, m0016TwoFactor];
