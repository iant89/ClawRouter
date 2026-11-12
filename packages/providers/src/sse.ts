/** A parsed Server-Sent Event. */
export interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * Incremental SSE parser over a byte stream. Events are yielded as they arrive,
 * so the gateway never buffers a whole response (spec §13).
 */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | null = null;
  let data: string[] = [];
  const field = (line: string) => {
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (name === 'event') event = value;
    else if (name === 'data') data.push(value);
  };
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer[newline] === '\r' ? 2 : 1));
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = null;
          data = [];
        } else {
          field(line);
        }
      }
    }
    // Be lenient with servers that end the stream without a final blank line.
    if (buffer) field(buffer);
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
