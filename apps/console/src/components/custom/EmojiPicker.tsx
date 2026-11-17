import { useEffect, useMemo, useState } from 'react';
import { IconButton, Popover, SearchField, Text } from '@enterprise-ui/react';

/**
 * A small emoji picker: a "+" button that opens a searchable grid of emoji.
 * ENTERPRISE-UI has no emoji picker, so this composes its Popover (a candidate
 * for the design system if more screens need one). The set is curated for
 * operational messages rather than complete; each emoji has a name for search
 * and for screen readers.
 */
const GROUPS: { name: string; emoji: [string, string][] }[] = [
  {
    name: 'Status',
    emoji: [['⚠️', 'warning'], ['❗', 'exclamation'], ['❓', 'question'], ['✅', 'check done'], ['❌', 'cross failed'], ['🚫', 'blocked'], ['⛔', 'no entry'], ['🔴', 'red circle down'], ['🟠', 'orange circle'], ['🟡', 'yellow circle'], ['🟢', 'green circle up'], ['🔵', 'blue circle'], ['ℹ️', 'information'], ['🆕', 'new'], ['🆗', 'ok'], ['🔥', 'fire hot incident']],
  },
  {
    name: 'Work',
    emoji: [['🛠️', 'tools maintenance'], ['🔧', 'wrench fix'], ['⚙️', 'gear settings'], ['🚀', 'rocket launch release'], ['📦', 'package'], ['🧪', 'test experiment'], ['🐛', 'bug'], ['🔒', 'lock security'], ['🔑', 'key'], ['🛡️', 'shield'], ['📈', 'chart up'], ['📉', 'chart down'], ['💾', 'save disk'], ['🖥️', 'computer server'], ['☁️', 'cloud'], ['🔌', 'plug connection']],
  },
  {
    name: 'Time',
    emoji: [['⏰', 'alarm clock'], ['⏳', 'hourglass waiting'], ['⌛', 'hourglass done'], ['🕒', 'clock'], ['📅', 'calendar date'], ['🗓️', 'calendar schedule'], ['⏱️', 'stopwatch'], ['🔁', 'repeat'], ['⏸️', 'pause'], ['▶️', 'play start']],
  },
  {
    name: 'Messages',
    emoji: [['📢', 'loudspeaker announcement'], ['📣', 'megaphone'], ['💡', 'idea tip'], ['📌', 'pin'], ['📝', 'note memo'], ['📖', 'book docs'], ['🔗', 'link'], ['📬', 'mailbox'], ['💬', 'speech chat'], ['👉', 'point right'], ['⭐', 'star'], ['❤️', 'heart'], ['👍', 'thumbs up'], ['🙏', 'thanks please'], ['👋', 'wave hello'], ['🎉', 'party celebration']],
  },
  {
    name: 'Faces',
    emoji: [['🙂', 'smile'], ['😀', 'grin'], ['😉', 'wink'], ['😅', 'sweat relief'], ['🤔', 'thinking'], ['😮', 'surprised'], ['😬', 'grimace'], ['😴', 'sleep'], ['🤖', 'robot ai'], ['👀', 'eyes look']],
  },
];

export function EmojiPicker({ onPick, label = 'Insert emoji' }: { onPick: (emoji: string) => void; label?: string }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  // Escape closes the picker only, not the dialog it is in (this capture listener runs first).
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [open]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.map((g) => ({ ...g, emoji: g.emoji.filter(([e, name]) => name.includes(q) || e === q) })).filter((g) => g.emoji.length);
  }, [query]);

  return (
    <Popover
      trigger={<IconButton icon="add" label={label} variant="tertiary" />}
      aria-label="Emoji"
      placement="bottom-end"
      width="19rem"
      open={open}
      onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}
    >
      <div className="claw-emoji-picker">
        <SearchField aria-label="Search emoji" placeholder="Search: clock, fix, party…" value={query} onChange={setQuery} size="sm" />
        {groups.length === 0 && <Text size="sm" tone="secondary">No emoji match “{query}”.</Text>}
        {groups.map((g) => (
          <section key={g.name} aria-label={g.name}>
            <Text size="sm" tone="secondary">{g.name}</Text>
            <div className="claw-emoji-grid">
              {g.emoji.map(([e, name]) => (
                <button key={e} type="button" className="claw-emoji" title={name} aria-label={name} onClick={() => onPick(e)}>{e}</button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Popover>
  );
}

/** Inserts `text` at the cursor of a text field (or at the end), returning the new value and caret. */
export function insertAtCursor(field: HTMLTextAreaElement | HTMLInputElement | null, value: string, text: string): { value: string; caret: number } {
  const start = field?.selectionStart ?? value.length;
  const end = field?.selectionEnd ?? value.length;
  return { value: value.slice(0, start) + text + value.slice(end), caret: start + text.length };
}
