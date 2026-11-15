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
 * instead of under the field. Put it in an Input's `endAdornment`, or wrap any other
 * control in `WithFieldHelp` (below), which places it beside the control. Keep short,
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
export function FieldHelp({ label, children, anchor }: {
  label: string;
  children: ReactNode;
  /** The box the tip centres on; by default the field the button sits in. */
  anchor?: () => DOMRect | null;
}) {
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
      const r = anchor ? anchor() : fieldOf(button.current)?.getBoundingClientRect();
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
      if (e.key === 'Escape') {
        // Escape closes the tip only, not the dialog the field is in (this listener runs first).
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (typing) close();
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

const CONTROL = 'input:not([type="hidden"]), textarea, select, [role="combobox"]';

/**
 * Puts the "i" beside a control that has no `endAdornment` (NumberInput, Select,
 * MultiSelect, TextArea, PasswordInput, or a group of controls): just outside its
 * right edge, lined up with the control rather than its label (at the top for a
 * multi-line text area). The tip centres on the field, like FieldHelp in an Input.
 */
export function WithFieldHelp({ label, help, children, inline = false }: {
  label: string;
  help: ReactNode;
  children: ReactNode;
  /** The control keeps its own width and the "i" follows it, instead of filling the row. */
  inline?: boolean;
}) {
  const field = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    const row = field.current;
    if (!row) return;
    const align = () => {
      const control = row.querySelector<HTMLElement>(CONTROL);
      if (!control) return;
      const c = control.getBoundingClientRect();
      const top = row.getBoundingClientRect().top;
      const button = 28; // .claw-field-help-button block size
      setOffset(Math.max(0, Math.round(control.tagName === 'TEXTAREA' ? c.top - top + 4 : c.top - top + (c.height - button) / 2)));
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  // Centred on the field horizontally, on the control vertically.
  const anchor = () => {
    const row = field.current;
    const control = row?.querySelector<HTMLElement>(CONTROL);
    if (!row || !control) return row?.getBoundingClientRect() ?? null;
    const r = row.getBoundingClientRect();
    const c = control.getBoundingClientRect();
    return new DOMRect(r.left, c.top, r.width, c.height);
  };

  return (
    <div className={inline ? "claw-field-help-row claw-field-help-row-inline" : "claw-field-help-row"}>
      <div ref={field} className="claw-field-help-field">{children}</div>
      <span style={{ marginBlockStart: offset }}>
        <FieldHelp label={label} anchor={anchor}>{help}</FieldHelp>
      </span>
    </div>
  );
}
