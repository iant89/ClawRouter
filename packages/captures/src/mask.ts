import type { CaptureBody, CaptureDetail } from '@clawrouter/shared';

/**
 * "Mask message text" for exports: every string in the recorded bodies becomes
 * `[masked: N chars]` except the ones that describe structure (model, role,
 * type, ids, finish reasons…) and error objects, which a developer needs and
 * which carry no prompt or reply. Numbers, booleans and object keys stay, so
 * the shape of every request and reply is still there to debug.
 */

/** Keys whose string values are structure, not message text. */
const KEEP = new Set([
  'model', 'role', 'type', 'id', 'object', 'status', 'code', 'param', 'name', 'index', 'event',
  'finish_reason', 'finishReason', 'stop_reason', 'stop_sequence', 'tool_call_id', 'call_id', 'tool_choice',
  'system_fingerprint', 'service_tier', 'created', 'mime_type', 'mimeType', 'media_type', 'format', 'detail',
  'encoding_format', 'modelVersion', 'responseId', 'response_id', 'item_id', 'output_index', 'content_index',
  'sequence_number', 'x_groq', 'reasoning_effort', 'version',
]);

export const maskedText = (text: string) => `[masked: ${text.length} chars]`;

function maskValue(value: unknown, key: string | null, inError: boolean): unknown {
  if (typeof value === 'string') return inError || (key !== null && KEEP.has(key)) ? value : maskedText(value);
  if (Array.isArray(value)) return value.map((v) => maskValue(v, key, inError));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskValue(v, k, inError || k === 'error');
    return out;
  }
  return value;
}

/** Masks a JSON document, or each `data:` line of a server-sent event stream; other text is masked whole. */
export function maskBodyText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    return JSON.stringify(maskValue(JSON.parse(trimmed), null, false), null, 2);
  } catch {
    // not one JSON document
  }
  if (/^(data|event|id|retry):/m.test(text)) {
    return text
      .split('\n')
      .map((line) => {
        const m = /^data:\s?(.*)$/.exec(line);
        if (!m || m[1] === '[DONE]' || !m[1]) return line;
        try {
          return `data: ${JSON.stringify(maskValue(JSON.parse(m[1]), null, false))}`;
        } catch {
          return `data: ${maskedText(m[1])}`;
        }
      })
      .join('\n');
  }
  return maskedText(text);
}

const maskBody = (b: CaptureBody): CaptureBody => ({ ...b, text: maskBodyText(b.text) });

export function maskCapture(c: CaptureDetail): CaptureDetail {
  return {
    ...c,
    client: {
      request: { body: maskBody(c.client.request.body) },
      response: c.client.response ? { ...c.client.response, body: maskBody(c.client.response.body) } : null,
    },
    exchanges: c.exchanges.map((e) => ({
      ...e,
      request: { ...e.request, body: e.request.body ? maskBody(e.request.body) : null },
      response: e.response ? { ...e.response, body: maskBody(e.response.body) } : null,
    })),
  };
}
