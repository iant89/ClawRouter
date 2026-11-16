import type { Migration } from '../migrations.ts';

/**
 * Whether an API key may use ClawRouter's MCP server (/v1/mcp), which answers
 * with its owner's permissions. Off for every existing key: a key made for the
 * gateway must not start reading administration data.
 */
export const m0021ApiKeyMcpAccess: Migration = {
  id: '0021_api_key_mcp_access',
  up: `ALTER TABLE api_keys ADD COLUMN mcp_access INTEGER NOT NULL DEFAULT 0 CHECK (mcp_access IN (0, 1));`,
};
