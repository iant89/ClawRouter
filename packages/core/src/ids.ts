/** Random, URL-safe, unguessable identifier. */
export function newId(): string {
  return crypto.randomUUID();
}

/** Identifier for a single HTTP request, used for log correlation. */
export function newRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll('-', '')}`;
}
