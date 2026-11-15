import { useMemo } from 'react';
import { encodeQr } from './qr-code.ts';

/**
 * A QR code drawn in the browser as SVG (the value, e.g. a setup key, never leaves
 * the page). Dark modules on a white tile with the standard four-module quiet zone:
 * scanners need dark-on-light, whatever the console theme.
 */
export function QrCode({ value, label, size = 192 }: { value: string; label: string; size?: number }) {
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
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      shapeRendering="crispEdges"
      className="claw-qr-code"
    >
      <rect width={span} height={span} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
