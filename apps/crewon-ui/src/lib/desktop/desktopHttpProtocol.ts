/** Renderer/preload/main ship together; incompatible HTTP transports fail closed. */
export const DESKTOP_HTTP_VERSION = 2 as const;
export const DESKTOP_HTTP_LIMITS = Object.freeze({
  activeRequests: 32,
  readRequests: 24,
  requestBodyBytes: 2 * 1024 * 1024,
  requestBytes: 16 * 1024 * 1024,
  responseBytes: 64 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  eventChunkBytes: 8 * 1024,
  headerBytes: 32 * 1024,
  headers: 128,
  urlCharacters: 8192,
  handshakeMs: 30_000,
  consumerIdleMs: 60_000,
});

export type DesktopHttpReadResult =
  | Readonly<{ type: "chunk"; chunk: Uint8Array }>
  | Readonly<{ type: "end" }>;

export type DesktopHttpWireResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: string }>;

export function isDesktopEventStream(
  headers: readonly (readonly [string, string])[],
) {
  return /^text\/event-stream(?:;|$)/iu.test(
    headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "",
  );
}
