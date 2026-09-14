import type { IncomingMessage } from "node:http";
import { deliveryRequestBodyLimit } from "@crewon/domain/delivery-http-policy";
export const DEFAULT_WEB_REQUEST_BODY_BYTES = 64 * 1024;
export class RequestBodyTooLargeError extends Error {}
export function webRequestBodyLimit(method: string, url: string | URL): number {
  return deliveryRequestBodyLimit({
    method,
    url,
    defaultLimit: DEFAULT_WEB_REQUEST_BODY_BYTES,
  });
}
function validateDeclaredLength(
  value: string | null | undefined,
  limit: number,
): void {
  if (value === null || value === undefined) return;
  const number = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number > limit)
    throw new RequestBodyTooLargeError();
}
function combine(chunks: Uint8Array[], bytes: number): ArrayBuffer {
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}
export async function readIncomingBody(
  incoming: IncomingMessage,
  publicOrigin: string,
): Promise<ArrayBuffer> {
  const limit = webRequestBodyLimit(
    incoming.method ?? "GET",
    new URL(incoming.url ?? "/", publicOrigin),
  );
  validateDeclaredLength(incoming.headers["content-length"], limit);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const value of incoming.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > limit || chunks.length >= 4096)
      throw new RequestBodyTooLargeError();
    chunks.push(chunk);
  }
  return combine(chunks, total);
}
export async function readFetchRequestBody(
  request: Request,
): Promise<ArrayBuffer | null> {
  if (
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.body === null
  )
    return null;
  const limit = webRequestBodyLimit(request.method, request.url);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    validateDeclaredLength(request.headers.get("content-length"), limit);
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit || chunks.length >= 4096)
        throw new RequestBodyTooLargeError();
      chunks.push(chunk.value);
    }
    return combine(chunks, total);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
