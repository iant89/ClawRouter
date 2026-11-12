import { errors } from '@clawapi/core';
import type { Permission } from '@clawapi/shared';
import type { Handler } from './context.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Who may call a route. Required on every route, so access is always a
 * deliberate decision visible next to the path:
 *   - 'public'         no session needed (health, setup, sign-in);
 *   - 'authenticated'  any signed-in user, for their own data only (own session);
 *   - a Permission     signed in and holding that permission.
 */
export type Access = 'public' | 'authenticated' | Permission;

interface Route {
  method: HttpMethod;
  pattern: string;
  segments: string[];
  handler: Handler;
  access: Access;
}

export interface RouteMatch {
  handler: Handler;
  params: Record<string, string>;
  access: Access;
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

  add(method: HttpMethod, pattern: string, access: Access, handler: Handler): this {
    this.routes.push({ method, pattern, segments: split(pattern), handler, access });
    return this;
  }
  get(pattern: string, access: Access, handler: Handler) { return this.add('GET', pattern, access, handler); }
  post(pattern: string, access: Access, handler: Handler) { return this.add('POST', pattern, access, handler); }
  put(pattern: string, access: Access, handler: Handler) { return this.add('PUT', pattern, access, handler); }
  patch(pattern: string, access: Access, handler: Handler) { return this.add('PATCH', pattern, access, handler); }
  delete(pattern: string, access: Access, handler: Handler) { return this.add('DELETE', pattern, access, handler); }

  match(method: string, pathname: string): RouteMatch {
    const path = split(pathname);
    const allowed = new Set<string>();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, path);
      if (!params) continue;
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) return { handler: route.handler, params, access: route.access };
      allowed.add(route.method);
    }
    if (allowed.size) {
      if (allowed.has('GET')) allowed.add('HEAD');
      throw errors.methodNotAllowed([...allowed].sort());
    }
    throw errors.notFound();
  }

  list(): { method: HttpMethod; pattern: string; access: Access }[] {
    return this.routes.map(({ method, pattern, access }) => ({ method, pattern, access }));
  }
}
