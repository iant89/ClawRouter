import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@enterprise-ui/react';

const HOVER_DELAY_MS = 250;
/** Time to move the mouse from the button onto the tip before it closes. */
const LEAVE_GRACE_MS = 120;
const GAP = 8; // room for the arrow
const MARGIN = 16;

/** The field box the button sits in: the nearest ancestor holding the input (or the button itself). */
function fieldOf(button: HTMLElement | null): HTMLElement | null {
  for (let el = button?.parentElement; el; el = el.parentElement) {
    if (el.querySelector("input, textarea, select")) return el;
  }
  return button;
}

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
 *   on a tap on the tip itself (touch),
 *   on Escape, on a click or tap anywhere else, and when typing starts in a field.
 * No focus moves into it, so the field can be clicked and typed in at once.
 * Shaped like a Bootstrap tooltip (centred text, an arrow), in the page background
 * colour with a border, centred on the whole field. It is
 * drawn in a portal (cards clip their content), centred above the field or
 * below it when there is no room above, and follows it while the page scrolls. Its text
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
  const [placement, setPlacement] = useState<'top' | 'bottom'>('top');
  const [host, setHost] = useState<Element | null>(null);
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

  // The tip lives in the theme's container (not document.body) so it gets the
  // theme's colours and font; position: fixed still escapes the cards' clipping.
  useLayoutEffect(() => {
    setHost(button.current?.closest('[data-eui-theme]') ?? document.body);
  }, []);

  // Like a Bootstrap tooltip: centred above the field, its arrow pointing at the
  // field's centre; below when there is no room above. Kept inside the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = fieldOf(button.current)?.getBoundingClientRect();
      const tip = bubble.current;
      if (!r || !tip) return;
      const { offsetWidth: width, offsetHeight: height } = tip;
      const viewport = document.documentElement;
      const centre = r.left + r.width / 2;
      const left = Math.min(Math.max(MARGIN, centre - width / 2), viewport.clientWidth - MARGIN - width);
      const above = r.top - GAP - height >= MARGIN;
      setPlacement(above ? 'top' : 'bottom');
      setPosition({
        left,
        top: above ? r.top - GAP - height : r.bottom + GAP,
        '--claw-tip-arrow-x': `${Math.round(centre - left)}px`,
      } as CSSProperties);
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
      {host && createPortal(
        <span
          ref={bubble}
          id={id}
          role="tooltip"
          className="claw-field-help-bubble"
          data-placement={placement}
          hidden={!open}
          style={position}
          onPointerEnter={(e) => { if (mouse(e)) clearTimeout(timer.current); }}
          onPointerLeave={(e) => { if (mouse(e)) hoverOut(); }}
          // On touch screens the tip can cover the field above: a tap on it dismisses it.
          onPointerDown={(e) => { if (!mouse(e)) close(); }}
        >
          {children}
        </span>,
        host,
      )}
    </>
  );
}
