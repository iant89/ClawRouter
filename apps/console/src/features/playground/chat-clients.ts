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

/**
 * Chat applications tested with ClawRouter, shown at the bottom of the playground.
 * Each has a setup guide in docs/clients/; the snippet here is its essential
 * configuration, filled in with this server's address.
 */
export interface ChatClient {
  id: 'open-webui' | 'librechat' | 'claude-code';
  name: string;
  summary: string;
  /** The tested setup guide in the repository. */
  guideUrl: string;
  /** Where the configuration goes, shown above the snippet. */
  where: string;
  /** The configuration, with this server's base URL (`<origin>/v1`). */
  snippet: (baseUrl: string) => string;
}

const GUIDES = 'https://github.com/iant89/ClawRouter/blob/main/docs/clients';

export const CHAT_CLIENTS: readonly ChatClient[] = [
  {
    id: 'open-webui',
    name: 'Open WebUI',
    summary: 'A self-hosted chat interface. Every model and alias your key may use appears in its model menu. Tested with version 0.13.4.',
    guideUrl: `${GUIDES}/open-webui.md`,
    where: 'Environment variables (Docker shown). From a container, a ClawRouter on the same machine is at host.docker.internal, not 127.0.0.1. Turn off Builtin Tools (see the guide) to see announcements in replies.',
    snippet: (baseUrl) => [
      'docker run -d --name open-webui -p 3000:8080 \\',
      '  --add-host=host.docker.internal:host-gateway \\',
      `  -e OPENAI_API_BASE_URL=${baseUrl} \\`,
      '  -e OPENAI_API_KEY=crk_your_key \\',
      '  -e ENABLE_OLLAMA_API=false \\',
      '  -v open-webui:/app/backend/data \\',
      '  ghcr.io/open-webui/open-webui:main',
    ].join('\n'),
  },
  {
    id: 'librechat',
    name: 'LibreChat',
    summary: 'A multi-user chat application. ClawRouter is added as a custom endpoint in librechat.yaml. Tested with version 0.8.9.',
    guideUrl: `${GUIDES}/librechat.md`,
    where: 'librechat.yaml, with CLAWROUTER_API_KEY=crk_your_key in LibreChat\'s .env file.',
    snippet: (baseUrl) => [
      'version: 1.3.19',
      'endpoints:',
      '  custom:',
      '    - name: "ClawRouter"',
      '      apiKey: "${CLAWROUTER_API_KEY}"',
      `      baseURL: "${baseUrl}"`,
      '      models:',
      '        default: ["your-alias"]',
      '        fetch: true',
      '      titleConvo: true',
      '      titleModel: "current_model"',
      '      modelDisplayLabel: "ClawRouter"',
    ].join('\n'),
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    summary: 'Anthropic\'s coding agent, through ClawRouter\'s Anthropic-compatible /v1/messages: any tool-using model can run it. Tested with version 2.1.328.',
    guideUrl: `${GUIDES}/claude-code.md`,
    where: 'Environment variables where you start Claude Code. The base URL has no /v1: Claude Code adds it. The model needs Tool use, and room for large requests.',
    snippet: (baseUrl) => [
      `export ANTHROPIC_BASE_URL=${baseUrl.replace(/\/v1$/, '')}`,
      'export ANTHROPIC_AUTH_TOKEN=crk_your_key',
      'export ANTHROPIC_MODEL=your-alias',
      'export ANTHROPIC_DEFAULT_HAIKU_MODEL=your-alias',
      'claude',
    ].join('\n'),
  },
];
