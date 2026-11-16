import { errors, type Logger } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import type { Database, SettingsRepository } from '@clawrouter/database';
import {
  SETUP_WIZARD_STATUSES, SETUP_WIZARD_STEPS,
  type FieldIssue, type OnboardingInfo, type SetupWizardState, type SetupWizardStatus, type SetupWizardStep, type TourState,
} from '@clawrouter/shared';
import type { ClientInfo } from './auth-service.ts';
import { createSqliteTourRepository } from './sqlite/onboarding.ts';

/** Stored as a setting; a fresh installation has none, which means "not run yet". */
const WIZARD_KEY = 'onboarding.setup_wizard';
const PENDING: SetupWizardState = { status: 'PENDING', step: null };

export type OnboardingService = ReturnType<typeof createOnboardingService>;

/**
 * First-run onboarding (owner request, 2026-11-16). The setup wizard belongs to
 * the installation: run by someone who can change settings, it records where it
 * got to so it can resume, and its end (finished or dismissed) is audited. The
 * guided tour belongs to each user: shown once, at the first sign-in, and
 * remembered whether finished or skipped. Users from before this existed are
 * marked as having seen it (migration 0020). Nothing here grants anything: the
 * wizard's steps call the ordinary APIs, which check their own permissions.
 */
export function createOnboardingService(options: { db: Database; settings: SettingsRepository; audit: AuditService; log?: Logger }) {
  const { settings, audit, log } = options;
  const tours = createSqliteTourRepository(options.db);

  const wizard = (): SetupWizardState => {
    const value = settings.get(WIZARD_KEY)?.value as Partial<SetupWizardState> | undefined;
    if (!value || !(SETUP_WIZARD_STATUSES as readonly string[]).includes(value.status ?? '')) return PENDING;
    const step = (SETUP_WIZARD_STEPS as readonly string[]).includes(value.step ?? '') ? (value.step as SetupWizardStep) : null;
    return { status: value.status as SetupWizardStatus, step };
  };

  return {
    /** What the console should offer this user. The wizard only to those who can change settings. */
    infoFor(userId: string, permissions: ReadonlySet<string>): OnboardingInfo {
      return { tour: tours.get(userId) ?? 'COMPLETED', setupWizard: permissions.has('settings.write') ? wizard() : null };
    },

    setupWizard: wizard,

    /** Saves where the wizard is (PENDING with a step), or ends it (COMPLETED or DISMISSED). */
    updateSetupWizard(actor: { id: string; username: string }, input: { status: unknown; step?: unknown }, client: ClientInfo): SetupWizardState {
      const issues: FieldIssue[] = [];
      if (!(SETUP_WIZARD_STATUSES as readonly unknown[]).includes(input.status)) issues.push({ path: 'status', message: `must be one of ${SETUP_WIZARD_STATUSES.join(', ')}` });
      if (input.step !== undefined && input.step !== null && !(SETUP_WIZARD_STEPS as readonly unknown[]).includes(input.step)) issues.push({ path: 'step', message: `must be one of ${SETUP_WIZARD_STEPS.join(', ')}, or null` });
      if (issues.length) throw errors.validation(issues);
      const before = wizard();
      const status = input.status as SetupWizardStatus;
      const next: SetupWizardState = { status, step: status === 'PENDING' ? ((input.step as SetupWizardStep | null | undefined) ?? before.step) : null };
      settings.set(WIZARD_KEY, { status: next.status, step: next.step });
      if (status !== 'PENDING' && before.status !== status) {
        audit.record({
          action: status === 'COMPLETED' ? 'SETUP_WIZARD_COMPLETED' : 'SETUP_WIZARD_DISMISSED', result: 'SUCCESS',
          resource: 'system', resourceId: 'setup_wizard', actor: { id: actor.id, name: actor.username },
          ip: client.ip, requestId: client.requestId ?? null, metadata: { lastStep: before.step },
        });
      }
      return next;
    },

    tour(userId: string): TourState {
      return tours.get(userId) ?? 'COMPLETED';
    },

    /** The user finished or skipped their tour; it is not shown at sign-in again (they can replay it). */
    finishTour(userId: string, outcome: unknown): TourState {
      if (outcome !== 'COMPLETED' && outcome !== 'SKIPPED') throw errors.validation([{ path: 'outcome', message: 'must be COMPLETED or SKIPPED' }]);
      tours.set(userId, outcome);
      log?.info('guided tour finished', { component: 'onboarding', userId, outcome });
      return outcome;
    },
  };
}
