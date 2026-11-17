# Client notices and announcements

Owner request, 2026-11-17: ClawRouter tells the people and apps using its API about
problems and news, in the responses they already receive. Two kinds of notice:

- **System notices**, from ClawRouter itself: degraded health, and a request answered by a
  backup model (failover). Their messages are editable.
- **Announcements**, written by administrators, each with its own schedule and expiry.

## Where notices go

| Channel | What the client sees | Setting (default) |
| --- | --- | --- |
| Header | `X-ClawRouter-Notices: [{"kind":"announcement","icon":"📢","text":"…"}]`, a JSON array in ASCII (non-ASCII as `\u` escapes) | **Send notices in a response header** (on) |
| Reply text | The reply starts with one line per notice, then a blank line: `⚠️ ClawRouter: …` (system) or `📢 ClawRouter: …` (announcement, or the icon it was given) | **Write notices at the start of replies** (on) |

A client can't be made to draw an icon or a banner; the emoji is part of the text.

The reply text is **never** added:
- to requests that offer tools, or to replies that call tools (clients read those as data);
- to embeddings (the header is still sent);
- for API keys whose **Notices at the start of replies** switch is off. This is per key and on by default; turn it off for scripts and apps that read replies. You set it when creating a key, and administrators can change it later in the key's menu.

Streams get the text as the first piece of content, before anything the model writes. In the
Responses API the text is part of the output text.

## Cleanup of conversations sent back

Chat apps send earlier replies back with each new message. With **Remove notices from
conversations sent back** (on), ClawRouter removes its own notice block from assistant
messages before the provider sees them. The model never reads the notice and never bills for it.

The block is removed only when it sits at the very start of an assistant message, in exactly
the form ClawRouter writes it (`stripNotices` in `packages/notices/src/format.ts`).
Quoted or edited text is left alone; if a client rewrites old messages, the model just sees
a harmless line. The cost is a string match per assistant message.

## System notices

Settings → Client notices → **Notice messages** (needs `announcements.manage`): each one can be
turned off or reworded (one line, up to 300 characters), or restored to the built-in text.

| Notice | Sent when | Built-in text |
| --- | --- | --- |
| Degraded health | A health check other than providers is degraded or offline, **every** provider is offline, or the provider that answered is degraded or offline | ClawRouter health has degraded; you may experience temporary performance issues. |
| Failover | Another model answered because the first choice failed | Your request was answered by a backup model because the first choice was unavailable. |

Each goes to an API key at most once per **Repeat system notices at most every** (30 minutes);
this is held in memory, per process.

The health rule deliberately ignores the platform's overall label, which also counts a provider
that has not been checked yet. The first live check (2026-11-17) showed that would tell every
user of a fresh install that health had degraded. One provider down among several isn't
reported either: requests fail over, and get the failover notice instead.

## Announcements

Administration → Announcements (`announcements.manage`, Administrators only by default).

| Field | |
| --- | --- |
| Type | The icon the line starts with, from a fixed list: 📢 Announcement (default), 📣 Megaphone, ℹ️ Information, 💡 Tip, ⚠️ Warning, ❗ Important, 🛠️ Maintenance, ⏰ Scheduled, 🚀 New feature, 🎉 Celebration, ✅ Resolved, 🔒 Security, 📅 Event, 🆕 New. Also sent as `icon` in the header |
| Message | One line, up to 300 characters. The **+** beside it opens an emoji picker (searchable, about 70 emoji) that inserts at the cursor; a preview shows the line as it will appear |
| How often | Every request · Once per user · Once a day (first request of the day) · Once a week (first request of the week, from Monday) |
| Where | Header and reply text · Header only · Reply text only |
| Starts / Expires | Optional. Not sent before the start; **deleted automatically** at the expiry (with who received it) |
| Time zone | Where a day or week begins (daily and weekly only); defaults to the administrator's browser |
| Active | Pause without deleting |

"User" means the API key's **owner**: all of a person's keys share one schedule, so "once" is once
per person. A key without an owner counts on its own. An announcement counts as delivered only
when one of its channels carried it; with reply text only, a tool request does not use up "once".
At most 20 can be active at a time. Creating, changing and deleting are audited
(`ANNOUNCEMENT_*`), as are changes to the messages (`SETTINGS_CHANGED`). The list shows how many
users each one reached and how many times it was sent.

## Checked live (Groq, 2026-11-17)

- A daily announcement started a real gpt-oss-20b reply and appeared in the header; the next
  request that day had neither.
- A failover through an alias produced the failover notice, and a stream within the interval did not.
- The first reply, sent back as history, reached Groq without its notice line (seen in a manual
  capture).
- A key with notices in replies off got the header only.

## Code

| Where | What |
| --- | --- |
| `packages/notices/src/service.ts` | Decides the notices per response; messages; announcements; `healthProblemIn` |
| `packages/notices/src/format.ts` | Reply lines, the header value, `stripNotices` |
| `packages/notices/src/periods.ts` | Day and week keys in a time zone |
| `packages/gateway/src/service.ts` | `noticesFor` (header, reply prefix) and `withoutNotices` (cleanup) in `runChat` and embeddings |
| `packages/api/src/controllers/notices.ts` | `/api/settings/notices`, `/api/announcements` |
| migration `0024_client_notices` | `announcements`, `announcement_deliveries`, `api_keys.reply_notices` |

Tests: `packages/api/test/notices-api.test.ts`. Screenshots: [`screenshots/31-notices/`](screenshots/README.md#31--client-notices-and-announcements).

## Icons and the cleanup

The cleanup recognises a notice line by its icon, so announcement icons come from a fixed list
(`ANNOUNCEMENT_ICONS` in `packages/shared/src/notices.ts`, migration 0025). Each icon matches with
or without the emoji variation selector (U+FE0F), which some clients drop. **Add icons, never
remove one**: a removed icon would stop the cleanup for replies that already carry it. Emoji in
the message text itself are free (they are not part of the match).

The picker is `apps/console/src/components/custom/EmojiPicker.tsx` (ENTERPRISE-UI has none; a
candidate for the design system). Escape closes the picker only, not the dialog it is in.
The Type box is select-like (ENTERPRISE-UI ComboBox `editable={false}` and `openOnClick`, owner
request 2026-11-17): a click opens it, it cannot be typed in, Space or Enter open it, and a letter
jumps to the next type starting with it (M for Maintenance).
