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

// SEC-027 corpus: request smuggling. A proxy in front and ClawRouter must never disagree about
// where a request ends: anything ambiguous is refused and the connection closed, so a second
// request hidden in the first never reaches ClawRouter.

import { afterAll, describe, expect, test } from 'bun:test';
import { createHarness } from '../support.ts';
import { sendRaw, serveRaw } from './raw-http.ts';

const h = createHarness();
await h.completeSetup();
const srv = serveRaw(h);
afterAll(() => srv.stop());

const HIDDEN = 'GET /api/users HTTP/1.1\r\nHost: x\r\n\r\n';

describe('request smuggling', () => {
  test.each([
    ['Content-Length and Transfer-Encoding (CL.TE)', `POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Length: 6\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n${HIDDEN}`],
    ['Transfer-Encoding and Content-Length (TE.CL)', `POST /api/auth/login HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n${HIDDEN.length.toString(16)}\r\n${HIDDEN}\r\n0\r\n\r\n`],
    ['two different Content-Lengths', `POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nContent-Length: ${2 + HIDDEN.length}\r\n\r\n{}${HIDDEN}`],
    ['a Content-Length list', `POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Length: 2, ${2 + HIDDEN.length}\r\n\r\n{}${HIDDEN}`],
    ['a disguised Transfer-Encoding', `POST /api/auth/login HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: xchunked\r\nContent-Length: 2\r\n\r\n{}${HIDDEN}`],
    ['Transfer-Encoding with a space before the colon', `POST /api/auth/login HTTP/1.1\r\nHost: x\r\nTransfer-Encoding : chunked\r\nContent-Length: 2\r\n\r\n{}${HIDDEN}`],
    ['a coding list ending in chunked', `POST /api/auth/login HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: identity, chunked\r\n\r\n0\r\n\r\n${HIDDEN}`],
    ['chunked on HTTP/1.0', `POST /api/auth/login HTTP/1.0\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n${HIDDEN}`],
    ['a signed Content-Length', `POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Length: +2\r\n\r\n{}${HIDDEN}`],
    ['a malformed chunk size', `POST /api/auth/login HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n2x\r\n{}\r\n0\r\n\r\n${HIDDEN}`],
  ])('CASE-021: %s is refused, the connection closed, the hidden request never handled', async (_name, raw) => {
    srv.reached.length = 0;
    const r = await sendRaw(srv.port, raw);
    // Bun refuses the framing (400) and closes. When the headers alone were valid, ClawRouter may
    // already have answered the first request (also 4xx here); the hidden one never runs.
    expect(r.statuses.length).toBeGreaterThan(0);
    expect(r.statuses.every((s) => s >= 400 && s < 500)).toBe(true);
    expect(r.statuses.at(-1)).toBe(400);
    expect(r.closedByServer).toBe(true);
    expect(srv.reached.every((x) => x === "POST /api/auth/login")).toBe(true);
  });
});
