import { errors } from '@clawapi/core';
import type { Handler } from './context.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteOptions {
  /**
   * Reachable without a session. Routes are protected by default so a
   * forgotten flag fails closed.
   */
  public?: boolean;
}

interface Route {
  method: HttpMethod;
  pattern: string;
  segments: string[];
  handler: Handler;
  public: boolean;
}

export interface RouteMatch {
  handler: Handler;
  params: Record<string, string>;
  public: boolean;
}

const split = (path: string) => path.split('/').filter(Boolean);

function matchSegments(pattern: string[], path: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i]!;
    if (seg === '*') return params; // wildcard tail
    const part = path[i];
    if (part === undefined) return null;
    if (seg.startsWith(':')) {
      try {
        params[seg.slice(1)] = decodeURIComponent(part);
      } catch {
        return null;
      }
    } else if (seg !== part) return null;
  }
  return pattern.length === path.length ? params : null;
}

/**
 * Minimal method + path router. Static segments, `:param` segments and a
 * trailing `*`. Unknown paths raise NOT_FOUND; known paths with the wrong
 * method raise METHOD_NOT_ALLOWED with an `Allow` header.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: HttpMethod, pattern: string, handler: Handler, options: RouteOptions = {}): this {
    this.routes.push({ method, pattern, segments: split(pattern), handler, public: options.public ?? false });
    return this;
  }
  get(pattern: string, handler: Handler, options?: RouteOptions) { return this.add('GET', pattern, handler, options); }
  post(pattern: string, handler: Handler, options?: RouteOptions) { return this.add('POST', pattern, handler, options); }
  put(pattern: string, handler: Handler, options?: RouteOptions) { return this.add('PUT', pattern, handler, options); }
  patch(pattern: string, handler: Handler, options?: RouteOptions) { return this.add('PATCH', pattern, handler, options); }
  delete(pattern: string, handler: Handler, options?: RouteOptions) { return this.add('DELETE', pattern, handler, options); }

  match(method: string, pathname: string): RouteMatch {
    const path = split(pathname);
    const allowed = new Set<string>();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, path);
      if (!params) continue;
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) return { handler: route.handler, params, public: route.public };
      allowed.add(route.method);
    }
    if (allowed.size) {
      if (allowed.has('GET')) allowed.add('HEAD');
      throw errors.methodNotAllowed([...allowed].sort());
    }
    throw errors.notFound();
  }

  list(): { method: HttpMethod; pattern: string; public: boolean }[] {
    return this.routes.map(({ method, pattern, public: isPublic }) => ({ method, pattern, public: isPublic }));
  }
}
