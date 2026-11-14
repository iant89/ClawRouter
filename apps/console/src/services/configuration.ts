import type { ConfigurationDocument, ImportPlan, ImportResult } from '@clawrouter/shared';
import { apiGet, apiPost } from './api-client.ts';

// Configuration export/import (phase 17). The document never contains secrets.
export const exportConfiguration = () => apiGet<ConfigurationDocument>('/api/configuration/export');
export const previewImport = (doc: unknown) => apiPost<ImportPlan>('/api/configuration/import/preview', doc);
export const applyImport = (doc: unknown) => apiPost<ImportResult>('/api/configuration/import', doc);
