import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@enterprise-ui/react';

const HOVER_DELAY_MS = 250;
/** Time to move the mouse from the button onto the tip before it closes. */
const LEAVE_GRACE_MS = 120;
const GAP = 8;
const MARGIN = 16;

/**
 * An "i" button for a form field's longer explanation, shown like a tooltip
 * instead of under the field. Put it in the field's `endAdornment`; keep short,
 * essential hints (allowed range, default) under the field as its description.
 *
 * Behaves as a toggletip, so it also works on touch screens (ENTERPRISE-UI's
 * Tooltip opens on hover and focus only):
 * - opens on mouse hover (after a short delay) and on keyboard focus;
 * - a click or tap keeps it open;
 * - closes when the mouse leaves (unless kept open), when focus moves elsewhere,
 *   on Escape, on a click or tap anywhere else, and when typing starts in a field.
 * No focus moves into it, so the field can be clicked and typed in at once.
 * The tip is drawn in a portal (cards clip their content), below the button or
 * above it when there is no room, and follows it while the page scrolls. Its text
 * is the button's description (`aria-describedby`), read by screen readers on focus.
 */
export function FieldHelp({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [shown, setShown] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const open = shown || pinned;

  const close = () => {
    clearTimeout(timer.current);
    setShown(false);
    setPinned(false);
  };
  const hoverIn = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(true), delay);
  };
  const hoverOut = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(false), LEAVE_GRACE_MS);
  };
  const mouse = (e: { pointerType: string }) => e.pointerType === 'mouse'; // touch opens with the tap

  // Place the tip under the button, right edges aligned; above it when it does not fit below.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = button.current?.getBoundingClientRect();
      const height = bubble.current?.offsetHeight ?? 0;
      if (!r) return;
      const viewport = document.documentElement;
      const right = Math.max(MARGIN, viewport.clientWidth - r.right - GAP);
      const below = r.bottom + GAP + height <= viewport.clientHeight - MARGIN || r.top - GAP - height < MARGIN;
      setPosition(below ? { top: r.bottom + GAP, right } : { bottom: viewport.clientHeight - r.top + GAP, right });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !bubble.current?.contains(t)) close();
    };
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]');
      if (e.key === 'Escape' || typing) close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="claw-field-help-button"
        aria-label={`About ${label}`}
        aria-describedby={id}
        aria-expanded={open}
        onPointerEnter={(e) => { if (mouse(e)) hoverIn(HOVER_DELAY_MS); }}
        onPointerLeave={(e) => { if (mouse(e)) hoverOut(); }}
        onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) setShown(true); }}
        // Focus moving to another control (Tab, a click on a field) closes it; a click on
        // the tip's own text (nothing focusable) leaves a kept-open tip open.
        onBlur={(e) => { if (e.relatedTarget) close(); else setShown(false); }}
        onClick={() => {
          clearTimeout(timer.current);
          setPinned((p) => !p);
          setShown(false);
        }}
      >
        <Icon name="information" size="sm" />
      </button>
      {createPortal(
        <span
          ref={bubble}
          id={id}
          role="tooltip"
          className="claw-field-help-bubble"
          hidden={!open}
          style={position}
          onPointerEnter={(e) => { if (mouse(e)) clearTimeout(timer.current); }}
          onPointerLeave={(e) => { if (mouse(e)) hoverOut(); }}
        >
          {children}
        </span>,
        document.body,
      )}
    </>
  );
}
