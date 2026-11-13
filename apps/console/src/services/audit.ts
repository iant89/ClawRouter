import type { AuditRecord, AuditSearch, PageMeta } from '@clawrouter/shared';
import { requestEnvelope } from './api-client.ts';

export interface AuditPage {
  items: AuditRecord[];
  total: number;
  page: number;
  pageSize: number;
  /** Resource types present in the log, for the filter. */
  resources: string[];
}

export async function fetchAudit(q: AuditSearch, signal?: AbortSignal): Promise<AuditPage> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  const env = await requestEnvelope<AuditRecord[]>('GET', `/api/audit?${p}`, undefined, { signal });
  const meta = (env.meta ?? {}) as Partial<PageMeta> & { resources?: string[] };
  return { items: env.data, total: meta.total ?? env.data.length, page: meta.page ?? 1, pageSize: meta.pageSize ?? env.data.length, resources: meta.resources ?? [] };
}

/** "API_KEY_CREATED" → "API key created". */
export function auditActionLabel(action: string): string {
  const words = action.toLowerCase().split('_');
  const text = words.join(' ').replace(/\bapi key\b/, 'API key');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
