import { useMemo, useState } from 'react';
import { Button, Dialog } from '@enterprise-ui/react';
import { encodeQr } from './qr-code.ts';

/**
 * A QR code drawn in the browser as SVG (the value, e.g. a setup key, never leaves
 * the page). Dark modules on a white tile with the standard four-module quiet zone:
 * scanners need dark-on-light, whatever the console theme.
 */
export function QrCode({ value, label, size = 192, className = 'claw-qr-code' }: { value: string; label: string; size?: number; className?: string }) {
  const qr = useMemo(() => encodeQr(value), [value]);
  const quiet = 4;
  const span = qr.size + quiet * 2;
  // One path of 1×1 squares: small, and crisp at any scale.
  const path = useMemo(() => {
    let d = '';
    qr.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`; }));
    return d;
  }, [qr]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${span} ${span}`} shapeRendering="crispEdges" className={className}>
      <rect width={span} height={span} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/**
 * The QR code centred, as a button: a click (or Enter) opens a larger copy in a
 * dialog, easier to scan from across a desk or on a small laptop screen.
 */
export function EnlargeableQrCode({ value, label }: { value: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="claw-qr-centre">
      <button type="button" className="claw-qr-button" aria-label={`${label}. Show it larger`} onClick={() => setOpen(true)}>
        <QrCode value={value} label={label} />
      </button>
      <span className="claw-qr-hint">Click to enlarge</span>
      <Dialog open={open} onClose={() => setOpen(false)} title="Scan with your authenticator app" size="md"
        footer={<Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>}>
        <div className="claw-qr-centre">
          <QrCode value={value} label={label} size={360} className="claw-qr-code-large" />
        </div>
      </Dialog>
    </div>
  );
}
