import { ANNOUNCEMENT_ICONS, SYSTEM_NOTICE_ICON, type Notice } from '@clawrouter/shared';

/**
 * How notices look in a reply, and how ClawRouter recognises its own lines when a
 * client sends the conversation back. The format is fixed so the cleanup only
 * ever removes what ClawRouter wrote: lines at the very start of an assistant
 * message, each "<icon> ClawRouter: <text>", followed by one blank line.
 */
/** Every icon a notice line can start with: the system icon and the announcement icons. */
const ALL_ICONS = [SYSTEM_NOTICE_ICON, ...ANNOUNCEMENT_ICONS.map((i) => i.icon)];

/** One line: no line breaks, no leading or trailing space. */
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function noticeLine(n: Notice): string {
  return `${n.icon} ClawRouter: ${oneLine(n.text)}`;
}

/** The block written before the reply's own text. */
export function replyPrefix(notices: Notice[]): string {
  return notices.length ? `${notices.map(noticeLine).join('\n')}\n\n` : '';
}

/**
 * One or more notice lines at the very start, then a blank line (or the end of the
 * message). Clients and fonts sometimes drop the emoji variation selector (U+FE0F), so each
 * icon matches with or without it.
 */
const ICON = `(?:${[...new Set(ALL_ICONS.map((i) => i.replace(/\uFE0F/g, '')))].map((i) => `${i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\uFE0F?`).join('|')})`;
const LINE = `${ICON} ClawRouter: [^\n]*`;
const LEADING_NOTICES = new RegExp(`^(?:${LINE}\n)+(?:\n|$)|^${LINE}$`, 'u');

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
  const json = JSON.stringify(notices.map((n) => ({ kind: n.kind, icon: n.icon, text: oneLine(n.text) })));
  return json.replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
