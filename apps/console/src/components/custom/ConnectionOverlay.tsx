/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

import { useEffect, useRef, useState } from 'react';
import { Button, Icon, Spinner } from '@enterprise-ui/react';
import { useRealtime } from '../../features/realtime/RealtimeContext.tsx';

/** A drop shorter than this (a server restart, a slow client) passes without covering the page. */
const SHOW_AFTER_MS = 1_500;

/**
 * Covers the console while the live connection is lost (owner request): a
 * see-through layer with a spinner while reconnecting, and a "disconnected"
 * message with Retry once the quick attempts have failed. Until the connection is
 * back, everything behind it stays visible but is inert (no clicks, no keyboard
 * focus), dialogs, menus and toasts included. It renders inside the theme (fonts,
 * light or dark) rather than in a portal on <body>, which the theme does not reach.
 */
export function ConnectionOverlay() {
  const { state, retry } = useRealtime();
  const lost = state === 'reconnecting' || state === 'disconnected';
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!lost) {
      setShown(false);
      return;
    }
    if (state === 'disconnected') {
      setShown(true);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [lost, state]);

  const panel = useRef<HTMLDivElement>(null);
  const active = lost && shown;
  useEffect(() => {
    if (!active) return;
    // Everything but the overlay and its ancestors: the page, the theme's dialog and menu layer, toasts, other portals.
    const restore: Element[] = [];
    for (let node: Element | null = panel.current; node && node !== document.body; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement?.children ?? [])) {
        if (sibling === node || sibling.hasAttribute('inert') || sibling.tagName === 'SCRIPT') continue;
        sibling.setAttribute('inert', '');
        restore.push(sibling);
      }
    }
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    before?.blur();
    return () => {
      for (const el of restore) el.removeAttribute('inert');
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [active]);

  const retryButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active && state === 'disconnected') retryButton.current?.focus();
  }, [active, state]);

  if (!active) return null;
  return (
    <div ref={panel} className="claw-connection-overlay" role="alertdialog" aria-modal="true" aria-labelledby="connection-overlay-title" aria-describedby="connection-overlay-text">
      {state === 'reconnecting' ? (
        <div className="claw-connection-overlay__body" aria-live="polite">
          <Spinner size="lg" decorative />
          <h2 id="connection-overlay-title">Reconnecting…</h2>
          <p id="connection-overlay-text">The connection to the ClawRouter server was lost. The page stays as it was until it is back.</p>
        </div>
      ) : (
        <div className="claw-connection-overlay__body" aria-live="assertive">
          <span className="claw-connection-overlay__icon" aria-hidden="true"><Icon name="disconnected" size={72} /></span>
          <h2 id="connection-overlay-title">Disconnected</h2>
          <p id="connection-overlay-text">
            The console cannot reach the ClawRouter server. It may be restarting, or the network may be down. What this page shows may be out of date.
            ClawRouter keeps trying every 30 seconds.
          </p>
          <Button ref={retryButton} variant="primary" icon="refresh" onClick={retry}>Retry</Button>
        </div>
      )}
    </div>
  );
}
