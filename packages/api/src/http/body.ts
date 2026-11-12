import { AppError, parse, type Validator } from '@clawapi/core';
import type { RequestContext } from './context.ts';

export const DEFAULT_BODY_LIMIT = 64 * 1024;

/**
 * Reads and validates a JSON body. Requires `Content-Type: application/json`,
 * which browsers cannot send cross-site without a CORS preflight (CSRF defence).
 */
export async function readJson<T>(ctx: RequestContext, validator: Validator<T>, limit = DEFAULT_BODY_LIMIT): Promise<T> {
  const type = ctx.request.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    throw new AppError('VALIDATION_ERROR', 'Content-Type must be application/json.');
  }
  const declared = Number(ctx.request.headers.get('content-length') ?? '0');
  if (declared > limit) throw new AppError('VALIDATION_ERROR', 'Request body is too large.');
  const text = await ctx.request.text();
  if (text.length > limit) throw new AppError('VALIDATION_ERROR', 'Request body is too large.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Request body is not valid JSON.');
  }
  return parse(validator, value);
}
