import { errors } from '@clawapi/core';
import type { Handler } from './context.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Route {
  method: HttpMethod;
  pattern: string;
  segments: string[];
  handler: Handler;
}

export interface RouteMatch {
  handler: Handler;
  params: Record<string, string>;
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

  add(method: HttpMethod, pattern: string, handler: Handler): this {
    this.routes.push({ method, pattern, segments: split(pattern), handler });
    return this;
  }
  get(pattern: string, handler: Handler) { return this.add('GET', pattern, handler); }
  post(pattern: string, handler: Handler) { return this.add('POST', pattern, handler); }
  put(pattern: string, handler: Handler) { return this.add('PUT', pattern, handler); }
  patch(pattern: string, handler: Handler) { return this.add('PATCH', pattern, handler); }
  delete(pattern: string, handler: Handler) { return this.add('DELETE', pattern, handler); }

  match(method: string, pathname: string): RouteMatch {
    const path = split(pathname);
    const allowed = new Set<string>();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, path);
      if (!params) continue;
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) return { handler: route.handler, params };
      allowed.add(route.method);
    }
    if (allowed.size) {
      if (allowed.has('GET')) allowed.add('HEAD');
      throw errors.methodNotAllowed([...allowed].sort());
    }
    throw errors.notFound();
  }

  list(): { method: HttpMethod; pattern: string }[] {
    return this.routes.map(({ method, pattern }) => ({ method, pattern }));
  }
}
