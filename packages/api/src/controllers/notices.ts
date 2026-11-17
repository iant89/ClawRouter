import { errors, v, type Validator } from '@clawrouter/core';
import type { NoticeService } from '@clawrouter/notices';
import {
  ANNOUNCEMENT_CHANNELS, ANNOUNCEMENT_FREQUENCIES, ANNOUNCEMENT_ICONS, NOTICE_TEXT_MAX,
  type AnnouncementInfo, type NoticeMessages,
} from '@clawrouter/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { noContent, ok } from '../http/responses.ts';

/** An ISO date-time, or null to clear it. Shape only; the service checks the values. */
const dateOrNull: Validator<string | null> = (value, path, issues) => {
  if (value === null) return null;
  if (typeof value === 'string' && value.length <= 40) return value;
  issues.push({ path, message: 'must be an ISO date-time or null' });
  return undefined;
};
/** `optional` drops null, so nullable dates are checked by hand. */
const optionalDate: Validator<string | null | undefined> = (value, path, issues) => (value === undefined ? undefined : dateOrNull(value, path, issues));

const message = v.string({ min: 1, max: NOTICE_TEXT_MAX + 50 });
const timeZone = v.string({ min: 1, max: 64 });
const icon = v.optional(v.oneOf(ANNOUNCEMENT_ICONS.map((i) => i.icon)));
const createBody = v.object({
  message,
  icon,
  frequency: v.oneOf(ANNOUNCEMENT_FREQUENCIES),
  channel: v.oneOf(ANNOUNCEMENT_CHANNELS),
  startsAt: optionalDate,
  expiresAt: optionalDate,
  timeZone,
  enabled: v.optional(v.boolean()),
});
const updateBody = v.object({
  message: v.optional(message),
  icon,
  frequency: v.optional(v.oneOf(ANNOUNCEMENT_FREQUENCIES)),
  channel: v.optional(v.oneOf(ANNOUNCEMENT_CHANNELS)),
  startsAt: optionalDate,
  expiresAt: optionalDate,
  timeZone: v.optional(timeZone),
  enabled: v.optional(v.boolean()),
});
const noticeMessage = v.optional(v.object({ enabled: v.optional(v.boolean()), text: v.optional(v.string({ max: NOTICE_TEXT_MAX + 50 })) }));
const messagesBody = v.object({ health: noticeMessage, failover: noticeMessage });

const actor = (ctx: RequestContext) => ({ id: ctx.auth!.user.id, username: ctx.auth!.user.username });
const client = (ctx: RequestContext) => ({ ip: ctx.ip, requestId: ctx.requestId });

/** /api/announcements and /api/settings/notices (owner request, 2026-11-17). */
export function noticesController(notices: NoticeService) {
  return {
    messages: (() => ok<NoticeMessages>(notices.messages())) satisfies Handler,
    updateMessages: (async (ctx) => ok<NoticeMessages>(notices.updateMessages(actor(ctx), await readJson(ctx, messagesBody), client(ctx)))) satisfies Handler,
    resetMessages: ((ctx) => ok<NoticeMessages>(notices.resetMessages(actor(ctx), client(ctx)))) satisfies Handler,
    list: (() => ok<AnnouncementInfo[]>(notices.listAnnouncements())) satisfies Handler,
    create: (async (ctx) => {
      const body = await readJson(ctx, createBody);
      const res = ok<AnnouncementInfo>(notices.createAnnouncement(actor(ctx), body, client(ctx)));
      return new Response(res.body, { status: 201, headers: res.headers });
    }) satisfies Handler,
    update: (async (ctx) => {
      if (!ctx.params.id) throw errors.notFound();
      return ok<AnnouncementInfo>(notices.updateAnnouncement(actor(ctx), ctx.params.id, await readJson(ctx, updateBody), client(ctx)));
    }) satisfies Handler,
    remove: ((ctx) => {
      if (!ctx.params.id) throw errors.notFound();
      notices.deleteAnnouncement(actor(ctx), ctx.params.id, client(ctx));
      return noContent();
    }) satisfies Handler,
  };
}
