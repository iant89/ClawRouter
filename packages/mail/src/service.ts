import { AppError, errors, type EventBus, type Logger, type SealedSecretStore, type SecretBox } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import type { JsonValue, SettingsRepository } from '@clawrouter/database';
import { MAIL_SECURITY, type FieldIssue, type MailServerSettings, type UpdateMailServerRequest } from '@clawrouter/shared';
import { addressOf, EMAIL_PATTERN, sendMail, SmtpError, type MailMessage, type SmtpConfig } from './smtp.ts';

/** Stored in the `settings` table under this key. The password is encrypted, never stored in plain text. */
const KEY = 'mail.server';
const PASSWORD_CONTEXT = 'settings:mail.server:password';

interface Stored {
  enabled: boolean;
  host: string;
  port: number;
  security: (typeof MAIL_SECURITY)[number];
  username: string | null;
  passwordCiphertext: string | null;
  from: string;
}

const DEFAULTS: Stored = { enabled: false, host: '', port: 587, security: 'starttls', username: null, passwordCiphertext: null, from: '' };

export type MailService = ReturnType<typeof createMailService>;

/**
 * The outgoing mail server (Administration → Settings), and sending through it.
 * Used for sign-in codes. Changes are audited without the password.
 */
export function createMailService(options: {
  settings: SettingsRepository;
  secrets: SecretBox;
  audit: AuditService;
  events?: EventBus;
  log?: Logger;
  /** Replaced in tests. */
  send?: typeof sendMail;
  /** Test mail servers have no certificates. Never false in production. */
  rejectUnauthorized?: boolean;
}) {
  const { settings, secrets, audit, events, log } = options;
  const send = options.send ?? sendMail;

  const load = (): Stored & { updatedAt: string | null } => {
    const s = settings.get(KEY);
    return { ...DEFAULTS, ...((s?.value as Partial<Stored> | undefined) ?? {}), updatedAt: s?.updatedAt ?? null };
  };

  const view = (s: Stored & { updatedAt: string | null }): MailServerSettings => ({
    enabled: s.enabled, host: s.host, port: s.port, security: s.security, username: s.username, passwordSet: s.passwordCiphertext !== null,
    from: s.from, configured: s.enabled && !!s.host && !!s.from, updatedAt: s.updatedAt,
  });

  async function config(): Promise<SmtpConfig> {
    const s = load();
    if (!(s.enabled && s.host && s.from)) throw new AppError('SERVICE_UNAVAILABLE', 'No mail server is configured. An administrator sets one up under Settings.', { expose: true });
    return {
      host: s.host, port: s.port, security: s.security, username: s.username, from: s.from,
      password: s.passwordCiphertext ? await secrets.decrypt(s.passwordCiphertext, PASSWORD_CONTEXT) : null,
      rejectUnauthorized: options.rejectUnauthorized ?? true,
    };
  }

  return {
    get: (): MailServerSettings => view(load()),
    configured: (): boolean => view(load()).configured,

    async update(actor: { id: string; username: string }, body: UpdateMailServerRequest, client: { ip: string | null; requestId?: string | null }): Promise<MailServerSettings> {
      const current = load();
      const next: Stored = { ...current };
      const issues: FieldIssue[] = [];
      if (body.enabled !== undefined) next.enabled = body.enabled;
      if (body.host !== undefined) {
        const host = body.host.trim();
        if (host && !/^[A-Za-z0-9.-]{1,253}$|^\[[0-9a-fA-F:.]+\]$/.test(host)) issues.push({ path: 'host', message: 'must be a host name or IP address' });
        next.host = host;
      }
      if (body.port !== undefined) {
        if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) issues.push({ path: 'port', message: 'must be 1–65535' });
        next.port = body.port;
      }
      if (body.security !== undefined) {
        if (!(MAIL_SECURITY as readonly string[]).includes(body.security)) issues.push({ path: 'security', message: `must be one of ${MAIL_SECURITY.join(', ')}` });
        next.security = body.security;
      }
      if (body.username !== undefined) next.username = body.username?.trim() || null;
      if (body.from !== undefined) {
        const from = body.from.trim();
        if (from && (!EMAIL_PATTERN.test(addressOf(from)) || /[\r\n]/.test(from) || from.length > 300)) issues.push({ path: 'from', message: 'must be an email address, optionally as "Name <address>"' });
        next.from = from;
      }
      if (body.password !== undefined && body.password !== null && (body.password.length > 1000 || /[\r\n]/.test(body.password))) issues.push({ path: 'password', message: 'must be at most 1000 characters on one line' });
      if (next.enabled && (!next.host || !next.from)) issues.push({ path: 'enabled', message: 'needs a host and a sender address first' });
      if (issues.length) throw errors.validation(issues);
      if (body.password !== undefined) next.passwordCiphertext = body.password === null || body.password === '' ? null : await secrets.encrypt(body.password, PASSWORD_CONTEXT);

      const changes: Record<string, { before: unknown; after: unknown }> = {};
      for (const k of ['enabled', 'host', 'port', 'security', 'username', 'from'] as const) {
        if (next[k] !== current[k]) changes[k] = { before: current[k], after: next[k] };
      }
      const passwordChanged = body.password !== undefined;
      settings.set(KEY, next as unknown as JsonValue);
      if (Object.keys(changes).length || passwordChanged) {
        audit.record({
          action: 'SETTINGS_CHANGED', result: 'SUCCESS', resource: 'settings', actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
          metadata: { mailServer: changes, ...(passwordChanged ? { signInDetailsChanged: true } : {}) },
        });
        events?.emit('settings.changed', { key: KEY });
      }
      return view(load());
    },

    /** Sends a message. Throws SERVICE_UNAVAILABLE when no server is configured, PROVIDER_ERROR when sending fails. */
    async send(message: MailMessage): Promise<void> {
      const cfg = await config();
      try {
        await send(cfg, message);
      } catch (error) {
        const reason = error instanceof SmtpError ? error.message : 'unexpected error';
        log?.warn('sending mail failed', { component: 'mail', host: cfg.host, reason });
        throw new AppError('PROVIDER_ERROR', `The mail server could not send the message: ${reason}.`, { expose: true, cause: error });
      }
    },
  };
}

/** The mail server password as a sealed secret (key rotation, checks, credential recovery). */
export function mailPasswordSecrets(settings: SettingsRepository): SealedSecretStore {
  const stored = () => settings.get(KEY)?.value as Partial<Stored> | undefined;
  return {
    name: 'mail server password',
    whenForgotten: 'the mail server signs in without a password until it is entered again (Settings → Mail server)',
    list: () => {
      const s = stored();
      return s?.passwordCiphertext ? [{ id: KEY, label: `mail server ${s.host ?? ''}`.trim(), context: PASSWORD_CONTEXT, ciphertext: s.passwordCiphertext, fingerprint: null }] : [];
    },
    replace(_id, from, ciphertext) {
      const s = stored();
      if (!s || s.passwordCiphertext !== from) return false;
      settings.set(KEY, { ...s, passwordCiphertext: ciphertext } as unknown as JsonValue);
      return true;
    },
    forget() {
      const s = stored();
      if (s) settings.set(KEY, { ...s, passwordCiphertext: null } as unknown as JsonValue);
    },
  };
}
