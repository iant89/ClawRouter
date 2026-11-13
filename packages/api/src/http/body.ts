import { AppError, parse, type Validator } from '@clawrouter/core';
import type { RequestContext } from './context.ts';

export const DEFAULT_BODY_LIMIT = 64 * 1024;

const tooLarge = (limit: number) => new AppError('VALIDATION_ERROR', `Request body is too large (limit ${formatBytes(limit)}).`);
const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${n / (1024 * 1024)} MB` : `${n / 1024} KB`);

/**
 * Reads the body as text, stopping as soon as it exceeds `limit` bytes. The
 * declared Content-Length is checked first, but a chunked body has none, so the
 * stream itself is counted: an oversized body is never buffered in full.
 */
export async function readBodyText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limit) throw tooLarge(limit);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(limit);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Reads a JSON body without a schema. Requires `Content-Type: application/json`,
 * which browsers cannot send cross-site without a CORS preflight (CSRF defence).
 */
export async function readJsonValue(ctx: RequestContext, limit = DEFAULT_BODY_LIMIT): Promise<unknown> {
  const type = ctx.request.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    throw new AppError('VALIDATION_ERROR', 'Content-Type must be application/json.');
  }
  const text = await readBodyText(ctx.request, limit);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Includes absurdly deep nesting (the parser gives up): never a 500.
    throw new AppError('VALIDATION_ERROR', 'Request body is not valid JSON.');
  }
}

/** Reads and validates a JSON body (administration API). */
export async function readJson<T>(ctx: RequestContext, validator: Validator<T>, limit = DEFAULT_BODY_LIMIT): Promise<T> {
  return parse(validator, await readJsonValue(ctx, limit));
}
