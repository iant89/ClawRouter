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

/** The corpus's raw HTTP/1.1 client: what a smuggling or desync attacker sends, byte for byte. */
import { connect } from 'node:net';
import type { Harness } from '../../support/harness.ts';

/** The harness API behind a real Bun server, recording every request that reached it. */
export function serveRaw(h: Harness) {
  const reached: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      reached.push(`${request.method} ${new URL(request.url).pathname}`);
      return h.api.handle(request, '127.0.0.1');
    },
  });
  return { reached, port: server.port!, stop: () => server.stop(true) };
}

/** Writes `data` on one connection; resolves with everything the server sent and whether it closed the connection. */
export function sendRaw(port: number, data: string | Uint8Array, waitMs = 400): Promise<{ text: string; statuses: number[]; closedByServer: boolean }> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    let closedByServer = true;
    socket.on('data', (d) => { text += d.toString('latin1'); });
    socket.on('error', () => {});
    const timer = setTimeout(() => { closedByServer = false; socket.destroy(); }, waitMs);
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ text, closedByServer, statuses: [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1])) });
    });
    socket.write(data);
  });
}
