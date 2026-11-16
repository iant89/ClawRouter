import { AppError, type Logger } from '@clawrouter/core';
import type { ApiKeyPrincipal } from '@clawrouter/gateway';
import { readBodyText } from '../http/body.ts';
import type { RequestContext } from '../http/context.ts';
import { allowedTools, MCP_TOOLS, ToolInputError, type McpCaller, type McpToolServices } from './tools.ts';

/**
 * ClawRouter's MCP server (Model Context Protocol, Streamable HTTP transport) at
 * POST /v1/mcp. Stateless: no sessions, no server-sent events; every request is
 * answered with one JSON-RPC response (or 202 for notifications), which the
 * transport allows. Authenticated with an API key that has MCP access; tools act
 * with the key owner's current permissions.
 */

/** Newest first. A client asking for one of these gets it; any other gets the newest. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const MCP_BODY_LIMIT = 256 * 1024;

const INSTRUCTIONS = 'ClawRouter is an AI gateway in front of OpenAI, Anthropic, Google, Groq and local models. '
  + 'These tools read its state: health, usage and cost, request history, providers, models, rate limits and the audit log. '
  + 'They answer with the permissions of the API key\'s owner, so some tools may be missing. Nothing here changes ClawRouter.';

type Id = string | number | null;
interface RpcMessage { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const rpc = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const rpcError = (id: Id, code: number, message: string, status = 200) => rpc({ jsonrpc: '2.0', id, error: { code, message } }, status);
const rpcResult = (id: Id, result: unknown) => rpc({ jsonrpc: '2.0', id, result });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Tool output for the model: the data as JSON text, and as structured content for clients that read it. */
function toolResult(data: unknown) {
  const structured = isObject(data) ? data : { items: data };
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured, isError: false };
}
const toolError = (message: string) => ({ content: [{ type: 'text', text: message }], isError: true });

/** An error's message with its field issues, which say what to change. */
function describe(error: AppError): string {
  const issues = (error.details as { issues?: { path: string; message: string }[] } | undefined)?.issues ?? [];
  return [error.message, ...issues.map((i) => `"${i.path}" ${i.message}.`)].join(' ');
}

export interface McpServerDependencies extends McpToolServices {
  /** The key owner's permissions, read again for every message (roles can change at any time). */
  permissionsOf(userId: string): McpCaller['permissions'];
  version: string;
  log: Logger;
}

export function createMcpHandler(deps: McpServerDependencies) {
  return async (ctx: RequestContext): Promise<Response> => {
    const key = ctx.apiKey as ApiKeyPrincipal; // the dispatcher guarantees a key with MCP access

    // DNS rebinding (MCP transport rules): a browser page on another site must not reach a local ClawRouter.
    const origin = ctx.request.headers.get('origin');
    if (origin !== null) {
      let host: string | null = null;
      try { host = new URL(origin).host; } catch { /* "null" or malformed */ }
      if (host !== ctx.url.host) throw new AppError('AUTHORIZATION_ERROR', 'Cross-site request rejected.', { expose: true });
    }
    const asked = ctx.request.headers.get('mcp-protocol-version');
    if (asked !== null && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)) {
      return rpcError(null, INVALID_REQUEST, `Unsupported MCP protocol version ${JSON.stringify(asked.slice(0, 40))}. Supported: ${MCP_PROTOCOL_VERSIONS.join(', ')}.`, 400);
    }

    let message: unknown;
    try {
      message = JSON.parse(await readBodyText(ctx.request, MCP_BODY_LIMIT));
    } catch (error) {
      if (error instanceof AppError) throw error; // body too large
      return rpcError(null, PARSE_ERROR, 'The body is not valid JSON.', 400);
    }
    if (Array.isArray(message)) return rpcError(null, INVALID_REQUEST, 'Batches are not supported: send one JSON-RPC message per request.', 400);
    if (!isObject(message) || message.jsonrpc !== '2.0') return rpcError(null, INVALID_REQUEST, 'Expected a JSON-RPC 2.0 message.', 400);
    const m = message as RpcMessage;
    const hasId = 'id' in m && (typeof m.id === 'string' || typeof m.id === 'number');
    // Notifications (no id) and responses to requests we never send need no answer.
    if (!hasId) return new Response(null, { status: 202 });
    const id = m.id as string | number;
    if (typeof m.method !== 'string') return rpcError(id, INVALID_REQUEST, 'Expected a method.', 400);
    const params = isObject(m.params) ? m.params : {};

    if (!key.ownerId) return rpcError(id, INVALID_REQUEST, 'This API key has no owner, so the MCP server has no permissions to act with.');
    const caller: McpCaller = { userId: key.ownerId, permissions: deps.permissionsOf(key.ownerId) };

    switch (m.method) {
      case 'initialize': {
        const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(wanted) ? wanted : MCP_PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'clawrouter', title: 'ClawRouter', version: deps.version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, {
          tools: allowedTools(caller).map((t) => ({
            name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
            annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          })),
        });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const tool = MCP_TOOLS.find((t) => t.name === name);
        // A tool the owner may not use is as unknown as one that does not exist: no probing for permissions.
        if (!tool || (tool.permission !== null && !caller.permissions.has(tool.permission))) {
          return rpcError(id, INVALID_PARAMS, `Unknown tool ${JSON.stringify(name.slice(0, 100))}. Call tools/list for the tools this key may use.`);
        }
        if (params.arguments !== undefined && !isObject(params.arguments)) return rpcError(id, INVALID_PARAMS, 'Tool arguments must be an object.');
        // Tool calls count against the key's rate limits, like gateway requests (a 429 refuses the call).
        const admission = await deps.limits.admit({ keyId: key.id, ownerId: key.ownerId, keyLimit: key.rateLimit }, ctx.requestId);
        const started = performance.now();
        try {
          const data = await tool.run(isObject(params.arguments) ? params.arguments : {}, caller, deps);
          ctx.log.info('mcp tool call', { component: 'mcp', tool: tool.name, prefix: key.prefix, outcome: 'ok', durationMs: Math.round(performance.now() - started) });
          return rpcResult(id, toolResult(data));
        } catch (error) {
          // Wrong arguments and "not found" go back to the model as tool errors it can act on.
          const message = error instanceof ToolInputError ? error.message
            : error instanceof AppError && (error.code === 'VALIDATION_ERROR' || error.code === 'NOT_FOUND') ? describe(error)
              : null;
          ctx.log.info('mcp tool call', { component: 'mcp', tool: tool.name, prefix: key.prefix, outcome: message ? 'tool_error' : 'failed', durationMs: Math.round(performance.now() - started) });
          if (message) return rpcResult(id, toolError(message));
          throw error;
        } finally {
          void admission.release();
        }
      }
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method ${JSON.stringify(m.method.slice(0, 100))} is not supported. This server offers tools only.`);
    }
  };
}
