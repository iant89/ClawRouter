import { v } from '@clawrouter/core';
import type { TwoFactorService } from '@clawrouter/authentication';
import type { MailService } from '@clawrouter/mail';
import {
  MAIL_SECURITY, TWO_FACTOR_REQUIREMENTS, type MailServerSettings, type RecoveryCodes, type SignInSecuritySettings, type TotpSetup, type TwoFactorStatus, type UserSummary,
} from '@clawrouter/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { ok } from '../http/responses.ts';

const password = () => v.string({ min: 1, max: 1024, trim: false });
const code = v.object({ code: v.string({ min: 1, max: 32 }) });
const disableBody = v.object({ method: v.oneOf(['totp', 'email'] as const), password: password() });
const passwordBody = v.object({ password: password() });
const emailBody = v.object({
  email: (value, path, issues) => {
    if (value === null) return null;
    if (typeof value === 'string' && value.length <= 254) return value;
    issues.push({ path, message: 'must be an email address or null' });
    return undefined;
  },
  password: password(),
});

const methodsField = (value: unknown, path: string, issues: { path: string; message: string }[]) => {
  if (value === undefined) return undefined;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<'totp' | 'email', boolean>;
  issues.push({ path, message: 'must be { totp: boolean, email: boolean }' });
  return undefined;
};
const signInBody = v.object({ methods: methodsField, require: v.optional(v.oneOf(TWO_FACTOR_REQUIREMENTS)) });

const nullableString = (max: number) => (value: unknown, path: string, issues: { path: string; message: string }[]) => {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string' && value.length <= max) return value;
  issues.push({ path, message: `must be text of at most ${max} characters, or null` });
  return undefined;
};
const mailBody = v.object({
  enabled: v.optional(v.boolean()),
  host: v.optional(v.string({ max: 253 })),
  port: (value, path, issues) => {
    if (value === undefined) return undefined;
    if (typeof value === 'number') return value;
    issues.push({ path, message: 'must be a number' });
    return undefined;
  },
  security: v.optional(v.oneOf(MAIL_SECURITY)),
  username: nullableString(320),
  password: nullableString(1000),
  from: v.optional(v.string({ max: 300 })),
});

const client = (ctx: RequestContext) => ({ ip: ctx.ip, userAgent: ctx.request.headers.get('user-agent'), requestId: ctx.requestId });
const me = (ctx: RequestContext) => ctx.auth!.user.id;
const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username });
/** Responses with recovery codes or authenticator secrets must not be cached anywhere. */
const secret = (res: Response) => {
  res.headers.set('cache-control', 'no-store');
  return res;
};

/** Two-factor enrollment (own account), the account email, and the administrator's settings. */
export function twoFactorController(twoFactor: TwoFactorService, mail: MailService) {
  return {
    status: ((ctx) => ok<TwoFactorStatus>(twoFactor.status(me(ctx)))) satisfies Handler,
    startTotp: (async (ctx) => secret(ok<TotpSetup>(await twoFactor.startTotp(me(ctx))))) satisfies Handler,
    confirmTotp: (async (ctx) => secret(ok<RecoveryCodes>(await twoFactor.confirmTotp(me(ctx), (await readJson(ctx, code)).code, client(ctx))))) satisfies Handler,
    startEmail: (async (ctx) => ok(await twoFactor.startEmail(me(ctx), client(ctx)))) satisfies Handler,
    confirmEmail: (async (ctx) => secret(ok<RecoveryCodes>(await twoFactor.confirmEmail(me(ctx), (await readJson(ctx, code)).code, client(ctx))))) satisfies Handler,
    disable: (async (ctx) => {
      const body = await readJson(ctx, disableBody);
      return ok<TwoFactorStatus>(await twoFactor.disable(me(ctx), body.method, body.password, client(ctx)));
    }) satisfies Handler,
    recoveryCodes: (async (ctx) => secret(ok<RecoveryCodes>(await twoFactor.regenerateRecoveryCodes(me(ctx), (await readJson(ctx, passwordBody)).password, client(ctx))))) satisfies Handler,
    changeEmail: (async (ctx) => {
      const body = await readJson(ctx, emailBody);
      return ok<UserSummary>(await twoFactor.changeEmail(me(ctx), body.email ?? null, body.password, client(ctx)));
    }) satisfies Handler,

    signInSettings: (() => ok<SignInSecuritySettings>(twoFactor.policy())) satisfies Handler,
    updateSignInSettings: (async (ctx) => ok<SignInSecuritySettings>(twoFactor.updatePolicy(actor(ctx), await readJson(ctx, signInBody), client(ctx)))) satisfies Handler,
    mailSettings: (() => ok<MailServerSettings>(mail.get())) satisfies Handler,
    updateMailSettings: (async (ctx) => ok<MailServerSettings>(await mail.update(actor(ctx), await readJson(ctx, mailBody), client(ctx)))) satisfies Handler,
    /** Sends a test message to the administrator's own address. */
    testMail: (async (ctx) => {
      const to = ctx.auth!.user.email;
      if (!to) return ok({ sent: false, reason: 'Add an email address to your account first (user menu → Account security).' });
      await mail.send({ to, subject: 'ClawRouter test message', text: `This is a test message from ClawRouter, sent by ${ctx.auth!.user.username}. Mail is working.` });
      return ok({ sent: true, to });
    }) satisfies Handler,
  };
}
