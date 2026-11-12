import type { Logger } from '@clawapi/core';

/** Per-request context passed through middleware and handlers. */
export interface RequestContext {
  readonly request: Request;
  readonly url: URL;
  readonly method: string;
  /** Path parameters from the matched route (`/api/providers/:id` -> `{ id }`). */
  params: Record<string, string>;
  readonly requestId: string;
  /** Client address as reported by the server (no proxy headers are trusted yet). */
  readonly ip: string | null;
  /** Request-scoped logger, bound to the request id. */
  log: Logger;
  /** Typed slots filled by middleware in later phases (session, principal, apiKey...). */
  state: Record<string, unknown>;
}

export type Handler = (ctx: RequestContext) => Response | Promise<Response>;
export type Next = () => Promise<Response>;
export type Middleware = (ctx: RequestContext, next: Next) => Response | Promise<Response>;

/** Runs middleware in order around `handler` (onion model). */
export function compose(middleware: readonly Middleware[], handler: Handler): Handler {
  return (ctx) => {
    let index = -1;
    const dispatch = async (i: number): Promise<Response> => {
      if (i <= index) throw new Error('next() called multiple times');
      index = i;
      const fn = middleware[i];
      if (!fn) return handler(ctx);
      return fn(ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  };
}
