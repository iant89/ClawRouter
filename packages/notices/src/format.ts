import type { Notice } from '@clawrouter/shared';

/**
 * How notices look in a reply, and how ClawRouter recognises its own lines when a
 * client sends the conversation back. The format is fixed so the cleanup only
 * ever removes what ClawRouter wrote: lines at the very start of an assistant
 * message, each "<icon> ClawRouter: <text>", followed by one blank line.
 */
export const NOTICE_ICONS = { system: '⚠️', announcement: '📢' } as const;

/** One line: no line breaks, no leading or trailing space. */
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function noticeLine(n: Notice): string {
  return `${n.kind === 'announcement' ? NOTICE_ICONS.announcement : NOTICE_ICONS.system} ClawRouter: ${oneLine(n.text)}`;
}

/** The block written before the reply's own text. */
export function replyPrefix(notices: Notice[]): string {
  return notices.length ? `${notices.map(noticeLine).join('\n')}\n\n` : '';
}

/** One or more notice lines at the very start, then a blank line (or the end of the message). */
const LEADING_NOTICES = /^(?:(?:⚠️|⚠|📢) ClawRouter: [^\n]*\n)+(?:\n|$)|^(?:(?:⚠️|⚠|📢) ClawRouter: [^\n]*)$/u;

/** Removes ClawRouter's notice block from the start of an assistant message; anything else is left alone. */
export function stripNotices(text: string): string {
  return text.replace(LEADING_NOTICES, '');
}

/**
 * The header value: a JSON array, ASCII only. Header values cannot carry
 * arbitrary Unicode, so every non-ASCII character is written as a JSON \u
 * escape, which any JSON parser turns back into the original text.
 */
export function headerValue(notices: Notice[]): string {
  const json = JSON.stringify(notices.map((n) => ({ kind: n.kind, text: oneLine(n.text) })));
  return json.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
